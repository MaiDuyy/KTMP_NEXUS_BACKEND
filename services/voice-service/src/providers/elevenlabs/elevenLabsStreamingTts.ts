import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { AsyncAudioQueue } from '../asyncAudioQueue.js';
import {
  StreamingTtsError,
  type StreamingTtsProvider,
  type StreamingTtsSegmentState,
  type StreamingTtsSession,
} from '../contracts.js';
import {
  CircuitBreaker,
  type CircuitPermit,
  type ProviderResilienceConfig,
  getResilienceObserver,
} from '../../resilience.js';
import type { ElevenLabsWebSocketFactory } from './elevenLabsStreamingStt.js';
import {
  ElevenLabsHttpError,
  ElevenLabsProtocolError,
  mapStreamingTtsError,
  sampleRateFromOutputFormat,
} from './elevenLabsCommon.js';

export interface ElevenLabsStreamingTtsConfig {
  apiKey: string;
  endpoint: string;
  voiceId: string;
  model: string;
  languageCode: string;
  outputFormat: string;
  firstAudioTimeoutMs: number;
  idleAudioTimeoutMs: number;
  totalTimeoutMs: number;
  maximumQueuedBytes: number;
}

function parseMessage(data: RawData): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ElevenLabsProtocolError('malformed_message');
  }
}

function buildUrl(config: ElevenLabsStreamingTtsConfig): string {
  const base = config.endpoint.replace(/\/$/, '');
  const url = new URL(`${base}/${encodeURIComponent(config.voiceId)}/stream-input`);
  url.searchParams.set('model_id', config.model);
  url.searchParams.set('language_code', config.languageCode);
  url.searchParams.set('output_format', config.outputFormat);
  return url.toString();
}

export class ElevenLabsStreamingTtsAdapter implements StreamingTtsProvider {
  public readonly circuitBreaker: CircuitBreaker;

  public constructor(
    private readonly config: ElevenLabsStreamingTtsConfig,
    resilienceConfig?: ProviderResilienceConfig,
    private readonly socketFactory: ElevenLabsWebSocketFactory = (url: string, options: ClientOptions) => new WebSocket(url, options),
  ) {
    this.circuitBreaker = new CircuitBreaker('elevenlabs_tts/streaming', {
      failureThreshold: resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public open(signal?: AbortSignal): StreamingTtsSession {
    let permit: CircuitPermit;
    try {
      permit = this.circuitBreaker.acquire();
    } catch (error) {
      throw mapStreamingTtsError(error);
    }

    let socket: WebSocket;
    try {
      socket = this.socketFactory(buildUrl(this.config), {
        headers: { 'xi-api-key': this.config.apiKey },
        handshakeTimeout: this.config.firstAudioTimeoutMs,
        perMessageDeflate: false,
      });
    } catch (error) {
      permit.recordFailure();
      throw mapStreamingTtsError(error);
    }

    const sampleRateHertz = sampleRateFromOutputFormat(this.config.outputFormat);
    const queue = new AsyncAudioQueue(this.config.maximumQueuedBytes);
    const ledger = new Map<number, StreamingTtsSegmentState>();
    let nextSegmentSequence = 0;
    let nextAudioSequence = 0;
    let finishRequested = false;
    let hasReceivedAudio = false;
    let terminal = false;
    let terminalError: StreamingTtsError | null = null;
    let audioTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = setTimeout(
      () => fail(new ElevenLabsProtocolError('timeout')),
      this.config.totalTimeoutMs,
    );
    let resolveOpened!: () => void;
    let rejectOpened!: (error: StreamingTtsError) => void;
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: StreamingTtsError) => void;
    const opened = new Promise<void>((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject; });
    const completed = new Promise<void>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
    void opened.catch(() => undefined);
    void completed.catch(() => undefined);

    const clearTimers = () => {
      if (audioTimer) clearTimeout(audioTimer);
      if (totalTimer) clearTimeout(totalTimer);
      audioTimer = null;
      totalTimer = null;
    };
    const cleanup = () => {
      clearTimers();
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
    const settlePermit = (error: StreamingTtsError | null) => {
      if (!error) permit.recordSuccess();
      else if (error.code === 'VOICE_TTS_UNAVAILABLE' || error.code === 'VOICE_TTS_TIMEOUT') permit.recordFailure();
      else permit.release();
      if (error?.code === 'VOICE_TTS_QUOTA_EXCEEDED') {
        getResilienceObserver()?.recordQuotaRejection('elevenlabs_tts');
      }
    };
    function fail(error: unknown): void {
      if (terminal) return;
      terminal = true;
      const mapped = mapStreamingTtsError(error);
      terminalError = mapped;
      const state: StreamingTtsSegmentState = mapped.code === 'VOICE_CANCELLED' ? 'CANCELLED' : 'FAILED';
      for (const [sequence, current] of ledger) {
        if (current === 'SENT_TO_TTS' || current === 'AUDIO_STARTED') ledger.set(sequence, state);
      }
      settlePermit(mapped);
      cleanup();
      closeSocket();
      queue.close(mapped);
      rejectOpened(mapped);
      rejectCompleted(mapped);
    }
    const succeed = () => {
      if (terminal) return;
      if (!hasReceivedAudio) {
        fail(new ElevenLabsProtocolError('empty_audio'));
        return;
      }
      terminal = true;
      for (const [sequence, state] of ledger) {
        if (state === 'SENT_TO_TTS' || state === 'AUDIO_STARTED') ledger.set(sequence, 'AUDIO_COMPLETED');
      }
      settlePermit(null);
      cleanup();
      closeSocket();
      queue.close();
      resolveCompleted();
    };
    const armAudioTimer = (timeoutMs: number) => {
      if (audioTimer) clearTimeout(audioTimer);
      audioTimer = setTimeout(() => fail(new ElevenLabsProtocolError('timeout')), timeoutMs);
    };
    const send = (payload: object) => {
      const encoded = JSON.stringify(payload);
      if (socket.readyState !== WebSocket.OPEN) throw new ElevenLabsProtocolError('socket_not_open');
      if (socket.bufferedAmount + Buffer.byteLength(encoded) > this.config.maximumQueuedBytes) {
        throw new ElevenLabsProtocolError('backpressure_limit');
      }
      socket.send(encoded);
    };
    const onOpen = () => {
      try {
        send({ text: ' ' });
        resolveOpened();
      } catch (error) {
        fail(error);
      }
    };
    const onMessage = (raw: RawData) => {
      if (terminal) return;
      try {
        const message = parseMessage(raw);
        if (message.error || typeof message.code === 'string') {
          throw new ElevenLabsProtocolError(typeof message.code === 'string' ? message.code : 'provider_error');
        }
        if (typeof message.audio === 'string' && message.audio.length > 0) {
          const audio = Buffer.from(message.audio, 'base64');
          if (audio.length === 0 || audio.length % 2 !== 0) throw new ElevenLabsProtocolError('malformed_audio');
          hasReceivedAudio = true;
          armAudioTimer(this.config.idleAudioTimeoutMs);
          const active = [...ledger.entries()].find(([, state]) => state === 'SENT_TO_TTS');
          if (active) ledger.set(active[0], 'AUDIO_STARTED');
          queue.push({
            segmentSequence: nextAudioSequence++,
            audio,
            encoding: 'PCM16LE',
            sampleRateHertz,
            channelCount: 1,
            receivedAtMs: Date.now(),
          });
        }
        if (message.is_final === true) {
          if (!finishRequested) throw new ElevenLabsProtocolError('unexpected_final');
          succeed();
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
      audio: queue,
      writeSegment: async (segmentSequence, text) => {
        if (terminal || finishRequested || signal?.aborted) {
          throw terminalError ?? new StreamingTtsError('VOICE_CANCELLED');
        }
        const clean = text.trim();
        if (!clean) throw new StreamingTtsError('VOICE_NO_SPEECH');
        if (clean.length > 5_000) throw new StreamingTtsError('VOICE_SPEECH_TOO_LONG');
        if (!Number.isSafeInteger(segmentSequence) || segmentSequence !== nextSegmentSequence) {
          throw new StreamingTtsError('VOICE_TTS_UNAVAILABLE');
        }
        await opened;
        if (terminal) throw terminalError ?? new StreamingTtsError('VOICE_TTS_UNAVAILABLE');
        try {
          send({ text: `${clean} `, try_trigger_generation: true });
          ledger.set(segmentSequence, 'SENT_TO_TTS');
          nextSegmentSequence += 1;
          if (!hasReceivedAudio) armAudioTimer(this.config.firstAudioTimeoutMs);
        } catch (error) {
          fail(error);
          throw mapStreamingTtsError(error);
        }
      },
      finish: async () => {
        if (ledger.size === 0 && !terminal) fail(new StreamingTtsError('VOICE_NO_SPEECH'));
        if (!finishRequested && !terminal) {
          finishRequested = true;
          await opened;
          if (terminal) return completed;
          try {
            send({ text: '' });
          } catch (error) {
            fail(error);
          }
        }
        await completed;
      },
      cancel: async () => {
        onAbort();
        try { await completed; } catch { /* Idempotent cleanup. */ }
      },
      getSegmentLedger: () => [...ledger.entries()]
        .map(([segmentSequence, state]) => ({ segmentSequence, state }))
        .sort((left, right) => left.segmentSequence - right.segmentSequence),
    };
  }
}
