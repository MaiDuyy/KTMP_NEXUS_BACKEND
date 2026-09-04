import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import type { CancellableStream } from 'google-gax';
import {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitPermit,
  ProviderResilienceConfig,
  getResilienceObserver,
} from '../resilience.js';

export interface StreamingTtsConfig {
  projectId: string;
  location: string;
  voiceName: string;
  sampleRateHertz: number;
  firstAudioTimeoutMs: number;
  idleAudioTimeoutMs: number;
  totalTimeoutMs: number;
  maximumQueuedBytes: number;
}

export interface StreamingPcmChunk {
  segmentSequence: number;
  audio: Buffer;
  encoding: 'PCM16LE';
  sampleRateHertz: number;
  channelCount: 1;
  receivedAtMs: number;
}

export type StreamingTtsSegmentState = 'SENT_TO_TTS' | 'AUDIO_STARTED' | 'AUDIO_COMPLETED' | 'CANCELLED' | 'FAILED';

export interface StreamingTtsSegmentLedgerEntry {
  segmentSequence: number;
  state: StreamingTtsSegmentState;
}

export interface StreamingTtsSession {
  writeSegment(segmentSequence: number, text: string): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
  audio: AsyncIterable<StreamingPcmChunk>;
  getSegmentLedger(): readonly StreamingTtsSegmentLedgerEntry[];
}

export interface StreamingTextToSpeechClient {
  streamingSynthesize(): CancellableStream;
}

export class StreamingTtsError extends Error {
  public constructor(
    public readonly code: 'VOICE_TTS_TIMEOUT' | 'VOICE_TTS_UNAVAILABLE' | 'VOICE_TTS_QUOTA_EXCEEDED' | 'VOICE_CANCELLED' | 'VOICE_NO_SPEECH' | 'VOICE_SPEECH_TOO_LONG',
    public readonly providerCode: string | number | null = null,
    public readonly providerMessage: string | null = null,
  ) {
    super(code);
  }
}

class AsyncAudioQueue implements AsyncIterable<StreamingPcmChunk> {
  private readonly values: StreamingPcmChunk[] = [];
  private readonly waiters: Array<{ resolve: (result: IteratorResult<StreamingPcmChunk>) => void; reject: (error: Error) => void }> = [];
  private bytes = 0;
  private closed = false;
  private failure: Error | null = null;

  public constructor(private readonly maximumBytes: number) {}

  public push(value: StreamingPcmChunk): void {
    if (this.closed) return;
    if (this.bytes + value.audio.length > this.maximumBytes) {
      this.close(new StreamingTtsError('VOICE_TTS_UNAVAILABLE'));
      throw new StreamingTtsError('VOICE_TTS_UNAVAILABLE');
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
    this.bytes += value.audio.length;
  }

  public close(error: Error | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<StreamingPcmChunk> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) {
          this.bytes -= value.audio.length;
          return Promise.resolve({ value, done: false });
        }
        if (this.failure) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<StreamingPcmChunk>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

function mapProviderError(error: unknown): StreamingTtsError {
  if (error instanceof StreamingTtsError) return error;
  if (error instanceof CircuitBreakerError) return new StreamingTtsError('VOICE_TTS_UNAVAILABLE');
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message.slice(0, 500) : null;
  const providerCode = typeof code === 'string' || typeof code === 'number' ? code : null;
  if (code === 8 || code === 'RESOURCE_EXHAUSTED') return new StreamingTtsError('VOICE_TTS_QUOTA_EXCEEDED', providerCode, message);
  if (code === 4 || code === 'DEADLINE_EXCEEDED') return new StreamingTtsError('VOICE_TTS_TIMEOUT', providerCode, message);
  if (code === 1 || code === 'CANCELLED' || (error instanceof Error && error.message === 'AbortError')) return new StreamingTtsError('VOICE_CANCELLED', providerCode, message);
  return new StreamingTtsError('VOICE_TTS_UNAVAILABLE', providerCode, message);
}

function toAudioBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  return null;
}

export class GoogleStreamingTtsAdapter {
  public readonly circuitBreaker: CircuitBreaker;
  private readonly client: StreamingTextToSpeechClient;
  private readonly resilienceConfig?: ProviderResilienceConfig;

  public constructor(
    private readonly config: StreamingTtsConfig,
    clientOrResilience?: StreamingTextToSpeechClient | ProviderResilienceConfig,
    resilienceConfig?: ProviderResilienceConfig,
  ) {
    if (clientOrResilience && 'streamingSynthesize' in clientOrResilience) {
      this.client = clientOrResilience;
      this.resilienceConfig = resilienceConfig;
    } else {
      this.resilienceConfig = clientOrResilience;
      this.client = new TextToSpeechClient({
        projectId: config.projectId,
        apiEndpoint: config.location && config.location !== 'global'
          ? `${config.location}-texttospeech.googleapis.com`
          : undefined,
      }) as unknown as StreamingTextToSpeechClient;
    }
    this.circuitBreaker = new CircuitBreaker('google_tts/streaming', {
      failureThreshold: this.resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: this.resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: this.resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: this.resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public open(signal?: AbortSignal): StreamingTtsSession {
    let permit: CircuitPermit;
    try {
      permit = this.circuitBreaker.acquire();
    } catch (err) {
      throw mapProviderError(err);
    }

    let stream: CancellableStream;
    try {
      stream = this.client.streamingSynthesize();
    } catch (err) {
      const mapped = mapProviderError(err);
      if (mapped.code === 'VOICE_TTS_TIMEOUT' || mapped.code === 'VOICE_TTS_UNAVAILABLE') {
        permit.recordFailure();
      } else {
        permit.release();
      }
      if (mapped.code === 'VOICE_TTS_QUOTA_EXCEEDED') {
        getResilienceObserver()?.recordQuotaRejection('google_tts');
      }
      throw mapped;
    }

    const queue = new AsyncAudioQueue(this.config.maximumQueuedBytes);
    const languageCode = this.config.voiceName.split('-').slice(0, 2).join('-');
    let terminal = false;
    let nextSegmentSequence = 0;
    let nextAudioSequence = 0;
    let finishRequested = false;
    let hasReceivedAudio = false;
    const ledger = new Map<number, StreamingTtsSegmentState>();
    let audioTimeout: ReturnType<typeof setTimeout> | null = null;
    let totalTimeout: ReturnType<typeof setTimeout> | null = null;
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: StreamingTtsError) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    void completed.catch(() => undefined);

    const clearTimeouts = () => {
      if (audioTimeout) clearTimeout(audioTimeout);
      if (totalTimeout) clearTimeout(totalTimeout);
      audioTimeout = null;
      totalTimeout = null;
    };
    const fail = (error: unknown) => {
      if (terminal) return;
      terminal = true;
      clearTimeouts();
      const mapped = mapProviderError(error);
      const state: StreamingTtsSegmentState = mapped.code === 'VOICE_CANCELLED' ? 'CANCELLED' : 'FAILED';
      for (const [sequence, current] of ledger) {
        if (current === 'SENT_TO_TTS' || current === 'AUDIO_STARTED') ledger.set(sequence, state);
      }
      if (mapped.code === 'VOICE_TTS_TIMEOUT' || mapped.code === 'VOICE_TTS_UNAVAILABLE') {
        permit.recordFailure();
      } else {
        permit.release();
      }
      if (mapped.code === 'VOICE_TTS_QUOTA_EXCEEDED') {
        getResilienceObserver()?.recordQuotaRejection('google_tts');
      }
      queue.close(mapped);
      stream.cancel();
      signal?.removeEventListener('abort', onAbort);
      rejectCompleted(mapped);
    };
    const armAudioTimeout = (duration: number) => {
      if (audioTimeout) clearTimeout(audioTimeout);
      audioTimeout = setTimeout(() => fail(new StreamingTtsError('VOICE_TTS_TIMEOUT')), duration);
    };
    const onAbort = () => fail(new StreamingTtsError('VOICE_CANCELLED'));
    const complete = () => {
      if (terminal) return;
      if (!hasReceivedAudio) {
        fail(new StreamingTtsError('VOICE_TTS_UNAVAILABLE'));
        return;
      }
      terminal = true;
      clearTimeouts();
      permit.recordSuccess();
      for (const [sequence, state] of ledger) {
        if (state === 'SENT_TO_TTS' || state === 'AUDIO_STARTED') ledger.set(sequence, 'AUDIO_COMPLETED');
      }
      queue.close();
      signal?.removeEventListener('abort', onAbort);
      resolveCompleted();
    };

    stream.on('data', (response: { audioContent?: unknown }) => {
      if (terminal) return;
      const audio = toAudioBuffer(response.audioContent);
      if (!audio || audio.length === 0) return;
      hasReceivedAudio = true;
      armAudioTimeout(this.config.idleAudioTimeoutMs);
      const nextAudioStarted = [...ledger.entries()].find(([, state]) => state === 'SENT_TO_TTS');
      if (nextAudioStarted) ledger.set(nextAudioStarted[0], 'AUDIO_STARTED');
      try {
        queue.push({
          segmentSequence: nextAudioSequence++,
          audio,
          encoding: 'PCM16LE',
          sampleRateHertz: this.config.sampleRateHertz,
          channelCount: 1,
          receivedAtMs: Date.now(),
        });
      } catch (error) {
        fail(error);
      }
    });
    stream.once('error', fail);
    const onProviderEnd = () => {
      if (!finishRequested) fail(new StreamingTtsError('VOICE_TTS_UNAVAILABLE'));
      else complete();
    };
    stream.once('end', onProviderEnd);
    stream.once('close', onProviderEnd);
    signal?.addEventListener('abort', onAbort, { once: true });
    armAudioTimeout(this.config.firstAudioTimeoutMs);
    totalTimeout = setTimeout(() => fail(new StreamingTtsError('VOICE_TTS_TIMEOUT')), this.config.totalTimeoutMs);

    try {
      stream.write({
        streamingConfig: {
          voice: { languageCode, name: this.config.voiceName },
          streamingAudioConfig: {
            audioEncoding: 'PCM',
            sampleRateHertz: this.config.sampleRateHertz,
          },
        },
      });
    } catch (err) {
      fail(err);
      throw mapProviderError(err);
    }

    return {
      audio: queue,
      writeSegment: async (segmentSequence, text) => {
        if (terminal || signal?.aborted) throw new StreamingTtsError('VOICE_CANCELLED');
        const clean = text.trim();
        if (!clean) throw new StreamingTtsError('VOICE_NO_SPEECH');
        if (clean.length > 5_000) throw new StreamingTtsError('VOICE_SPEECH_TOO_LONG');
        if (!Number.isSafeInteger(segmentSequence) || segmentSequence !== nextSegmentSequence) {
          throw new StreamingTtsError('VOICE_TTS_UNAVAILABLE');
        }
        ledger.set(segmentSequence, 'SENT_TO_TTS');
        let written: boolean;
        try {
          written = stream.write({ input: { text: clean } });
        } catch (err) {
          fail(err);
          throw mapProviderError(err);
        }
        if (!written) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (error: unknown) => {
              cleanup();
              fail(error);
              reject(mapProviderError(error));
            };
            const cleanup = () => { stream.off('drain', onDrain); stream.off('error', onError); };
            stream.once('drain', onDrain);
            stream.once('error', onError);
          });
        }
        nextSegmentSequence += 1;
      },
      finish: async () => {
        if (ledger.size === 0 && !terminal) {
          fail(new StreamingTtsError('VOICE_NO_SPEECH'));
        }
        if (!finishRequested && !terminal) {
          finishRequested = true;
          try {
            stream.end();
          } catch (err) {
            fail(err);
            throw mapProviderError(err);
          }
        }
        await completed;
      },
      cancel: async () => {
        fail(new StreamingTtsError('VOICE_CANCELLED'));
        try {
          await completed;
        } catch {
          // Cancellation is an idempotent cleanup operation for callers.
        }
      },
      getSegmentLedger: () => [...ledger.entries()]
        .map(([segmentSequence, state]) => ({ segmentSequence, state }))
        .sort((left, right) => left.segmentSequence - right.segmentSequence),
    };
  }
}
