import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  VOICE_STREAM_AUDIO_FRAME_TYPE,
  VOICE_STREAM_BINARY_HEADER_BYTES,
  VOICE_STREAM_CHANNEL_COUNT,
  VOICE_STREAM_CHUNK_DURATION_MS,
  VOICE_STREAM_PCM_BYTES_PER_CHUNK,
  VOICE_STREAM_PROTOCOL_VERSION,
  VOICE_STREAM_SAMPLE_RATE_HZ,
  type VoiceErrorCode,
  type VoiceStreamAuthFrame,
  type VoiceTurnCancelReason,
} from '@ott/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { VoiceServiceLogger } from '../logger.js';
import type { VerifiedVoiceTurnToken, VoiceTurnTokenVerifier } from '../turnTokenVerifier.js';

const MAX_AUTH_FRAME_BYTES = 8_192;
const CANCEL_REASONS = new Set<VoiceTurnCancelReason>([
  'user_cancelled',
  'call_ended',
  'owner_disconnected',
  'membership_changed',
  'timeout',
  'provider_error',
  'system',
]);
const STREAMING_SINK_ERROR_CODES = new Set<VoiceErrorCode>([
  'VOICE_STT_TIMEOUT',
  'VOICE_STT_UNAVAILABLE',
  'VOICE_CANCELLED',
  'VOICE_TURN_EXPIRED',
]);

function mapSinkError(error: unknown): VoiceErrorCode {
  if (error instanceof Error && STREAMING_SINK_ERROR_CODES.has(error.message as VoiceErrorCode)) {
    return error.message as VoiceErrorCode;
  }
  return 'VOICE_INTERNAL_ERROR';
}

export interface VoicePcmChunk {
  sequence: number;
  pcm: Buffer;
}

export interface VoicePcmStreamSink {
  write(chunk: VoicePcmChunk): Promise<void> | void;
  end(finalSequence: number | null): Promise<void> | void;
  cancel(reason: VoiceTurnCancelReason): Promise<void> | void;
}

export interface VoicePcmStreamSinkFactory {
  open(token: VerifiedVoiceTurnToken, signal: AbortSignal): Promise<VoicePcmStreamSink> | VoicePcmStreamSink;
}

export interface VoiceWebSocketServerOptions {
  logger: VoiceServiceLogger;
  verifier: VoiceTurnTokenVerifier;
  sinkFactory: VoicePcmStreamSinkFactory;
  allowedOrigins: ReadonlySet<string>;
  authTimeoutMs: number;
  idleTimeoutMs: number;
  maxDurationMs: number;
  maxQueuedBytes: number;
}

interface ParsedBinaryFrame {
  sequence: number;
  pcm: Buffer;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function parseTurnId(request: IncomingMessage): string | null {
  const pathname = new URL(request.url ?? '/', 'http://voice.local').pathname;
  const match = pathname.match(/^\/v1\/voice\/turns\/([^/]+)\/stream$/);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]);
    return value.length > 0
      && value.length <= 256
      && value.trim() === value
      && !/[\u0000-\u001f\u007f]/.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function parseBinaryFrame(data: RawData): ParsedBinaryFrame | null {
  const frame = rawDataToBuffer(data);
  if (frame.length !== VOICE_STREAM_BINARY_HEADER_BYTES + VOICE_STREAM_PCM_BYTES_PER_CHUNK) return null;
  if (frame.readUInt8(0) !== VOICE_STREAM_PROTOCOL_VERSION || frame.readUInt8(1) !== VOICE_STREAM_AUDIO_FRAME_TYPE) return null;
  return { sequence: frame.readUInt32BE(2), pcm: frame.subarray(VOICE_STREAM_BINARY_HEADER_BYTES) };
}

function parseJson(data: RawData): unknown {
  const buffer = rawDataToBuffer(data);
  if (buffer.length === 0 || buffer.length > MAX_AUTH_FRAME_BYTES) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

function isAuthFrame(value: unknown): value is VoiceStreamAuthFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Partial<VoiceStreamAuthFrame>;
  return frame.type === 'auth'
    && frame.protocolVersion === VOICE_STREAM_PROTOCOL_VERSION
    && typeof frame.turnId === 'string'
    && typeof frame.turnToken === 'string'
    && frame.turnToken.length > 0
    && frame.turnToken.length <= MAX_AUTH_FRAME_BYTES;
}

function isFinalSequence(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff);
}

class VoiceWebSocketConnection {
  private sink: VoicePcmStreamSink | null = null;
  private expectedSequence = 0;
  private queuedBytes = 0;
  private queue = Promise.resolve();
  private authenticated = false;
  private authenticating = false;
  private terminal = false;
  private readonly abortController = new AbortController();
  private readonly authTimer: NodeJS.Timeout;
  private idleTimer: NodeJS.Timeout | null = null;
  private durationTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly socket: WebSocket,
    private readonly turnId: string,
    private readonly options: VoiceWebSocketServerOptions,
  ) {
    this.authTimer = setTimeout(() => {
      this.fail('VOICE_STREAM_AUTH_TIMEOUT', 'Streaming authentication timed out.', false, 4408);
    }, options.authTimeoutMs);
    socket.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    socket.once('close', () => void this.onClose());
    socket.once('error', () => this.fail('VOICE_STREAM_DISCONNECTED', 'Streaming connection failed.', true, 4500));
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.terminal) return;
    if (!this.authenticated) {
      if (isBinary) {
        this.fail('VOICE_STREAM_PROTOCOL_ERROR', 'Authentication must be the first frame.', false, 4400);
        return;
      }
      void this.authenticate(parseJson(data));
      return;
    }

    if (isBinary) {
      this.acceptAudio(data);
      return;
    }
    this.acceptControl(parseJson(data));
  }

  private async authenticate(value: unknown): Promise<void> {
    if (this.authenticated || this.authenticating || this.terminal || !isAuthFrame(value) || value.turnId !== this.turnId) {
      this.fail('VOICE_TOKEN_INVALID', 'Invalid streaming credentials.', false, 4401);
      return;
    }
    this.authenticating = true;
    try {
      const token = await this.options.verifier.verifyAndConsume(value.turnToken);
      if (token.turnId !== this.turnId || this.terminal) throw new Error('invalid turn binding');
      this.sink = await this.options.sinkFactory.open(token, this.abortController.signal);
      if (this.terminal) {
        await this.sink.cancel('system');
        return;
      }
      this.authenticated = true;
      this.authenticating = false;
      clearTimeout(this.authTimer);
      this.resetIdleTimer();
      this.durationTimer = setTimeout(() => {
        this.fail('VOICE_STREAM_TIMEOUT', 'Streaming duration limit reached.', false, 4408);
      }, this.options.maxDurationMs);
      this.send({
        type: 'ready',
        protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
        audioFormat: {
          encoding: 'LINEAR16',
          sampleRateHz: VOICE_STREAM_SAMPLE_RATE_HZ,
          channelCount: VOICE_STREAM_CHANNEL_COUNT,
          chunkDurationMs: VOICE_STREAM_CHUNK_DURATION_MS,
        },
        maxQueuedBytes: this.options.maxQueuedBytes,
      });
    } catch {
      this.authenticating = false;
      this.fail('VOICE_TOKEN_INVALID', 'Invalid or already used streaming credentials.', false, 4401);
    }
  }

  private acceptAudio(data: RawData): void {
    const frame = parseBinaryFrame(data);
    if (!frame) {
      this.fail('VOICE_STREAM_PROTOCOL_ERROR', 'Invalid PCM frame.', false, 4400);
      return;
    }
    if (frame.sequence !== this.expectedSequence) {
      this.fail('VOICE_STREAM_SEQUENCE_ERROR', 'Audio sequence is not contiguous.', false, 4409);
      return;
    }
    if (this.queuedBytes + frame.pcm.length > this.options.maxQueuedBytes) {
      this.fail('VOICE_STREAM_BACKPRESSURE', 'Streaming audio queue is full.', true, 4413);
      return;
    }

    this.expectedSequence += 1;
    this.queuedBytes += frame.pcm.length;
    this.resetIdleTimer();
    this.queue = this.queue
      .then(async () => {
        if (this.abortController.signal.aborted || !this.sink) return;
        await this.sink.write(frame);
        this.queuedBytes -= frame.pcm.length;
        this.send({ type: 'ack', sequence: frame.sequence, queuedBytes: this.queuedBytes });
      })
      .catch((error: unknown) => this.failSink(error, 'Unable to process streaming audio.'));
  }

  private acceptControl(value: unknown): void {
    if (!value || typeof value !== 'object') {
      this.fail('VOICE_STREAM_PROTOCOL_ERROR', 'Invalid control frame.', false, 4400);
      return;
    }
    const frame = value as { type?: unknown; finalSequence?: unknown; reason?: unknown };
    if (frame.type === 'end' && isFinalSequence(frame.finalSequence)) {
      const expectedFinal = this.expectedSequence === 0 ? null : this.expectedSequence - 1;
      if (frame.finalSequence !== expectedFinal) {
        this.fail('VOICE_STREAM_SEQUENCE_ERROR', 'Final sequence does not match received audio.', false, 4409);
        return;
      }
      this.terminal = true;
      this.clearTimers();
      this.queue = this.queue.then(async () => {
        await this.sink?.end(frame.finalSequence as number | null);
        this.send({ type: 'finalized', finalSequence: frame.finalSequence });
        this.socket.close(1000, 'finalized');
      }).catch((error: unknown) => this.closeAfterSinkFailure(error));
      return;
    }
    if (frame.type === 'cancel' && typeof frame.reason === 'string' && CANCEL_REASONS.has(frame.reason as VoiceTurnCancelReason)) {
      this.terminal = true;
      this.clearTimers();
      this.abortController.abort();
      void Promise.resolve(this.sink?.cancel(frame.reason as VoiceTurnCancelReason)).finally(() => {
        this.socket.close(1000, 'cancelled');
      });
      return;
    }
    this.fail('VOICE_STREAM_PROTOCOL_ERROR', 'Unsupported control frame.', false, 4400);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.fail('VOICE_STREAM_TIMEOUT', 'Streaming audio idle timeout reached.', true, 4408);
    }, this.options.idleTimeoutMs);
  }

  private send(payload: object): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private fail(code: VoiceErrorCode, message: string, retryable: boolean, closeCode: number): void {
    if (this.terminal) return;
    this.terminal = true;
    this.clearTimers();
    this.abortController.abort();
    void Promise.resolve(this.sink?.cancel(code === 'VOICE_STREAM_TIMEOUT' ? 'timeout' : 'provider_error')).catch(() => undefined);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'error', code, message, retryable }), () => this.socket.close(closeCode, code));
    } else {
      this.socket.terminate();
    }
  }

  private failSink(error: unknown, fallbackMessage: string): void {
    const code = mapSinkError(error);
    this.fail(code, code === 'VOICE_INTERNAL_ERROR' ? fallbackMessage : code, true, 4500);
  }

  private closeAfterSinkFailure(error: unknown): void {
    this.terminal = false;
    this.failSink(error, 'Unable to finalize streaming audio.');
  }

  private async onClose(): Promise<void> {
    this.clearTimers();
    this.abortController.abort();
    if (!this.terminal && this.sink) {
      this.terminal = true;
      await Promise.resolve(this.sink.cancel('owner_disconnected')).catch(() => undefined);
    }
  }

  private clearTimers(): void {
    clearTimeout(this.authTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.idleTimer = null;
    this.durationTimer = null;
  }
}

export function attachVoiceWebSocketServer(server: HttpServer, options: VoiceWebSocketServerOptions): WebSocketServer {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_AUTH_FRAME_BYTES,
  });

  server.on('upgrade', (request, socket, head) => {
    const turnId = parseTurnId(request);
    if (!turnId) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !options.allowedOrigins.has(origin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      new VoiceWebSocketConnection(webSocket, turnId, options);
    });
  });

  server.once('close', () => {
    for (const client of webSocketServer.clients) client.terminate();
    webSocketServer.close();
  });
  return webSocketServer;
}
