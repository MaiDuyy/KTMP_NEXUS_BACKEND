import WebSocket, { type ClientOptions, type RawData } from 'ws';
import {
  StreamingSttError,
  type StreamingSttCallbacks,
  type StreamingSttProvider,
  type StreamingSttSession,
} from '../contracts.js';
import {
  CircuitBreaker,
  type CircuitPermit,
  type ProviderResilienceConfig,
  getResilienceObserver,
} from '../../resilience.js';
import {
  ElevenLabsHttpError,
  ElevenLabsProtocolError,
  mapStreamingSttError,
} from './elevenLabsCommon.js';

export interface ElevenLabsStreamingSttConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  languageCode: string;
  timeoutMs: number;
  maximumQueuedBytes: number;
  minimumChunkBytes?: number;
}

export type ElevenLabsWebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

function parseMessage(data: RawData): Record<string, unknown> {
  try {
    const decoded = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid');
    return decoded as Record<string, unknown>;
  } catch {
    throw new ElevenLabsProtocolError('malformed_message');
  }
}

function buildUrl(config: ElevenLabsStreamingSttConfig): string {
  const url = new URL(config.endpoint);
  url.searchParams.set('model_id', config.model);
  url.searchParams.set('audio_format', 'pcm_16000');
  url.searchParams.set('language_code', config.languageCode);
  url.searchParams.set('commit_strategy', 'manual');
  url.searchParams.set('include_timestamps', 'true');
  return url.toString();
}

export class ElevenLabsStreamingSttAdapter implements StreamingSttProvider {
  public readonly circuitBreaker: CircuitBreaker;

  public constructor(
    private readonly config: ElevenLabsStreamingSttConfig,
    resilienceConfig?: ProviderResilienceConfig,
    private readonly socketFactory: ElevenLabsWebSocketFactory = (url, options) => new WebSocket(url, options),
  ) {
    this.circuitBreaker = new CircuitBreaker('elevenlabs_stt/streaming', {
      failureThreshold: resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public open(
    callbacks: StreamingSttCallbacks,
    signal?: AbortSignal,
    _phrases: readonly string[] = [],
  ): StreamingSttSession {
    let permit: CircuitPermit;
    try {
      permit = this.circuitBreaker.acquire();
    } catch (error) {
      throw mapStreamingSttError(error);
    }

    let socket: WebSocket;
    try {
      socket = this.socketFactory(buildUrl(this.config), {
        headers: { 'xi-api-key': this.config.apiKey },
        handshakeTimeout: this.config.timeoutMs,
        perMessageDeflate: false,
      });
    } catch (error) {
      permit.recordFailure();
      throw mapStreamingSttError(error);
    }

    const minimumChunkBytes = this.config.minimumChunkBytes ?? 3_200;
    let pendingAudio = Buffer.alloc(0);
    let terminal = false;
    let terminalError: StreamingSttError | null = null;
    let finishRequested = false;
    let finalSequence = 0;
    let resolveOpened!: () => void;
    let rejectOpened!: (error: StreamingSttError) => void;
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: StreamingSttError) => void;
    const opened = new Promise<void>((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject; });
    const completed = new Promise<void>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
    void opened.catch(() => undefined);
    void completed.catch(() => undefined);

    let totalTimer: NodeJS.Timeout | null = setTimeout(
      () => fail(new ElevenLabsProtocolError('timeout')),
      this.config.timeoutMs,
    );

    const cleanup = () => {
      if (totalTimer) clearTimeout(totalTimer);
      totalTimer = null;
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('open', onOpen);
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('unexpected-response', onUnexpectedResponse);
    };
    const closeSocket = () => {
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.once('error', () => undefined);
        socket.terminate();
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
      }
    };
    const settlePermit = (error: StreamingSttError | null) => {
      if (!error) permit.recordSuccess();
      else if (error.code === 'VOICE_STT_UNAVAILABLE' || error.code === 'VOICE_STT_TIMEOUT') permit.recordFailure();
      else permit.release();
      if (error?.code === 'VOICE_STT_QUOTA_EXCEEDED') {
        getResilienceObserver()?.recordQuotaRejection('elevenlabs_stt');
      }
    };
    function fail(error: unknown): void {
      if (terminal) return;
      terminal = true;
      const mapped = mapStreamingSttError(error);
      terminalError = mapped;
      settlePermit(mapped);
      cleanup();
      closeSocket();
      rejectOpened(mapped);
      rejectCompleted(mapped);
    }
    const succeed = () => {
      if (terminal) return;
      terminal = true;
      settlePermit(null);
      cleanup();
      closeSocket();
      resolveCompleted();
    };
    const sendAudio = (audio: Buffer, commit: boolean) => {
      if (socket.readyState !== WebSocket.OPEN) throw new ElevenLabsProtocolError('socket_not_open');
      if (socket.bufferedAmount + audio.length > this.config.maximumQueuedBytes) {
        throw new ElevenLabsProtocolError('backpressure_limit');
      }
      socket.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: audio.toString('base64'),
        commit,
      }));
    };
    const onOpen = () => resolveOpened();
    const onMessage = (raw: RawData) => {
      if (terminal) return;
      try {
        const message = parseMessage(raw);
        const type = typeof message.message_type === 'string' ? message.message_type : '';
        if (type === 'partial_transcript' || type === 'committed_transcript') {
          const text = typeof message.text === 'string' ? message.text.trim() : '';
          const isFinal = type === 'committed_transcript';
          if (text) {
            callbacks.onResult({
              text,
              isFinal,
              stability: null,
              confidence: null,
              resultEndOffset: `${String(finalSequence).padStart(12, '0')}.000000000`,
            });
          }
          if (isFinal) {
            finalSequence += 1;
            if (finishRequested) succeed();
          }
          return;
        }
        if (type === 'session_started') return;
        if (['auth_error', 'quota_exceeded', 'rate_limited', 'transcriber_error', 'input_error'].includes(type)) {
          fail(new ElevenLabsProtocolError(type));
        }
      } catch (error) {
        fail(error);
      }
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => {
      if (!terminal) fail(new ElevenLabsProtocolError('abnormal_close'));
    };
    const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
      fail(new ElevenLabsHttpError(response.statusCode ?? 500));
    };
    const onAbort = () => fail(new ElevenLabsProtocolError('cancelled'));

    socket.once('open', onOpen);
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('unexpected-response', onUnexpectedResponse);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    return {
      write: async (pcm) => {
        if (terminal || finishRequested || signal?.aborted) {
          throw terminalError ?? new StreamingSttError('VOICE_CANCELLED');
        }
        if (pcm.length === 0 || pcm.length > 15_000 || pcm.length % 2 !== 0) {
          throw new StreamingSttError('VOICE_STT_UNAVAILABLE');
        }
        await opened;
        if (terminal) throw terminalError ?? new StreamingSttError('VOICE_STT_UNAVAILABLE');
        pendingAudio = pendingAudio.length === 0 ? Buffer.from(pcm) : Buffer.concat([pendingAudio, pcm]);
        if (pendingAudio.length > this.config.maximumQueuedBytes) {
          fail(new ElevenLabsProtocolError('backpressure_limit'));
          throw new StreamingSttError('VOICE_STT_UNAVAILABLE');
        }
        while (pendingAudio.length >= minimumChunkBytes) {
          const chunk = pendingAudio.subarray(0, minimumChunkBytes);
          pendingAudio = pendingAudio.subarray(minimumChunkBytes);
          try {
            sendAudio(chunk, false);
          } catch (error) {
            fail(error);
            throw mapStreamingSttError(error);
          }
        }
      },
      finish: async () => {
        if (terminal) return completed;
        if (!finishRequested) {
          finishRequested = true;
          await opened;
          if (terminal) return completed;
          try {
            sendAudio(pendingAudio, true);
            pendingAudio = Buffer.alloc(0);
          } catch (error) {
            fail(error);
          }
        }
        await completed;
      },
      cancel: () => onAbort(),
    };
  }
}
