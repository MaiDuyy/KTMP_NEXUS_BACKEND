import { v2 } from '@google-cloud/speech';
import type { CancellableStream } from 'google-gax';
import { normalizeSpeechPhrases } from './speechAdaptation.js';

export interface StreamingSttConfig {
  projectId: string;
  location: string;
  model: string;
  languageCode: string;
  timeoutMs: number;
  phrases?: readonly string[];
}

export interface StreamingSttResult {
  text: string;
  isFinal: boolean;
  stability: number | null;
  confidence: number | null;
  resultEndOffset: string;
}

export interface StreamingSttCallbacks {
  onResult(result: StreamingSttResult): void;
}

export interface StreamingSpeechClient {
  _streamingRecognize(options?: { timeout?: number }): CancellableStream;
}

export interface StreamingSttSession {
  write(pcm: Buffer): Promise<void>;
  finish(): Promise<void>;
  cancel(): void;
}

import {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitPermit,
  ProviderResilienceConfig,
  getResilienceObserver,
} from '../resilience.js';

export class StreamingSttError extends Error {
  public constructor(
    public readonly code: 'VOICE_STT_TIMEOUT' | 'VOICE_STT_UNAVAILABLE' | 'VOICE_STT_QUOTA_EXCEEDED' | 'VOICE_CANCELLED',
    public readonly providerCode: string | number | null = null,
    public readonly providerMessage: string | null = null,
  ) {
    super(code);
  }
}

function durationKey(duration: { seconds?: number | string | { toString(): string }; nanos?: number } | null | undefined): string {
  const seconds = duration?.seconds?.toString() ?? '0';
  const nanos = String(duration?.nanos ?? 0).padStart(9, '0');
  return `${seconds.padStart(12, '0')}.${nanos}`;
}

function mapProviderError(error: unknown): StreamingSttError {
  if (error instanceof StreamingSttError) return error;
  if (error instanceof CircuitBreakerError) {
    return new StreamingSttError('VOICE_STT_UNAVAILABLE');
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  const normalizedMessage = typeof message === 'string' ? message : null;
  if (code === 4 || code === 'DEADLINE_EXCEEDED') {
    return new StreamingSttError('VOICE_STT_TIMEOUT', typeof code === 'string' || typeof code === 'number' ? code : null, normalizedMessage);
  }
  if (code === 8 || code === 'RESOURCE_EXHAUSTED') {
    return new StreamingSttError('VOICE_STT_QUOTA_EXCEEDED', typeof code === 'string' || typeof code === 'number' ? code : null, normalizedMessage);
  }
  if (code === 1 || code === 'CANCELLED' || normalizedMessage?.includes('cancelled')) {
    return new StreamingSttError('VOICE_CANCELLED', typeof code === 'string' || typeof code === 'number' ? code : null, normalizedMessage);
  }
  return new StreamingSttError(
    'VOICE_STT_UNAVAILABLE',
    typeof code === 'string' || typeof code === 'number' ? code : null,
    normalizedMessage,
  );
}

export class GoogleStreamingSttAdapter {
  public readonly circuitBreaker: CircuitBreaker;
  private readonly client: StreamingSpeechClient;
  private readonly resilienceConfig?: ProviderResilienceConfig;

  public constructor(
    private readonly config: StreamingSttConfig,
    clientOrResilience?: StreamingSpeechClient | ProviderResilienceConfig,
    resilienceConfig?: ProviderResilienceConfig,
  ) {
    if (clientOrResilience && '_streamingRecognize' in clientOrResilience) {
      this.client = clientOrResilience;
      this.resilienceConfig = resilienceConfig;
    } else {
      this.resilienceConfig = clientOrResilience;
      this.client = new v2.SpeechClient({
        projectId: config.projectId,
        apiEndpoint: config.location && config.location !== 'global'
          ? `${config.location}-speech.googleapis.com`
          : undefined,
      }) as unknown as StreamingSpeechClient;
    }
    this.circuitBreaker = new CircuitBreaker('google_stt/streaming', {
      failureThreshold: this.resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: this.resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: this.resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: this.resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public open(
    callbacks: StreamingSttCallbacks,
    signal?: AbortSignal,
    turnPhrases: readonly string[] = [],
  ): StreamingSttSession {
    let permit: CircuitPermit;
    try {
      permit = this.circuitBreaker.acquire();
    } catch (err) {
      throw mapProviderError(err);
    }

    let stream: CancellableStream;
    try {
      stream = this.client._streamingRecognize({ timeout: this.config.timeoutMs });
    } catch (err) {
      const mapped = mapProviderError(err);
      if (mapped.code === 'VOICE_STT_UNAVAILABLE' || mapped.code === 'VOICE_STT_TIMEOUT') {
        permit.recordFailure();
      } else {
        permit.release();
      }
      if (mapped.code === 'VOICE_STT_QUOTA_EXCEEDED') {
        getResilienceObserver()?.recordQuotaRejection('google_stt');
      }
      throw mapped;
    }

    let settled = false;
    let settledError: StreamingSttError | null = null;
    let finishRequested = false;
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: StreamingSttError) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    void completed.catch(() => undefined);

    const settleSuccess = () => {
      if (settled) return;
      settled = true;
      permit.recordSuccess();
      resolveCompleted();
    };
    const settleError = (error: unknown) => {
      if (settled) return;
      settled = true;
      settledError = mapProviderError(error);
      if (settledError.code === 'VOICE_STT_UNAVAILABLE' || settledError.code === 'VOICE_STT_TIMEOUT') {
        permit.recordFailure();
      } else {
        permit.release();
      }
      if (settledError.code === 'VOICE_STT_QUOTA_EXCEEDED') {
        getResilienceObserver()?.recordQuotaRejection('google_stt');
      }
      rejectCompleted(settledError);
    };
    const onAbort = () => {
      stream.cancel();
      settleError(new StreamingSttError('VOICE_CANCELLED'));
    };

    stream.on('data', (response: any) => {
      for (const result of response?.results ?? []) {
        const alternative = result.alternatives?.[0];
        const text = typeof alternative?.transcript === 'string' ? alternative.transcript.trim() : '';
        if (!text) continue;
        callbacks.onResult({
          text,
          isFinal: result.isFinal === true,
          stability: typeof result.stability === 'number' ? result.stability : null,
          confidence: typeof alternative.confidence === 'number' ? alternative.confidence : null,
          resultEndOffset: durationKey(result.resultEndOffset),
        });
      }
    });
    stream.once('error', settleError);
    stream.once('end', () => {
      if (!finishRequested) {
        settleError(new StreamingSttError('VOICE_STT_UNAVAILABLE'));
        return;
      }
      settleSuccess();
    });
    stream.once('close', () => {
      if (!settled) {
        if (finishRequested) {
          settleSuccess();
        } else {
          settleError(new StreamingSttError('VOICE_STT_UNAVAILABLE'));
        }
      }
    });
    signal?.addEventListener('abort', onAbort, { once: true });

    const phrases = normalizeSpeechPhrases([...(this.config.phrases ?? []), ...turnPhrases]);
    try {
      stream.write({
        recognizer: `projects/${this.config.projectId}/locations/${this.config.location}/recognizers/_`,
        streamingConfig: {
          config: {
            explicitDecodingConfig: {
              encoding: 'LINEAR16',
              sampleRateHertz: 16_000,
              audioChannelCount: 1,
            },
            languageCodes: [this.config.languageCode],
            model: this.config.model,
            features: { enableAutomaticPunctuation: true },
            ...(phrases.length > 0 ? {
              adaptation: {
                phraseSets: [{
                  inlinePhraseSet: { phrases: phrases.map((value) => ({ value })) },
                }],
              },
            } : {}),
          },
          streamingFeatures: { interimResults: true },
        },
      });
    } catch (err) {
      settleError(err);
      throw settledError ?? mapProviderError(err);
    }

    return {
      write: async (pcm) => {
        if (settled) throw settledError ?? new StreamingSttError('VOICE_CANCELLED');
        if (finishRequested || signal?.aborted) throw new StreamingSttError('VOICE_CANCELLED');
        if (pcm.length === 0 || pcm.length > 15_000 || pcm.length % 2 !== 0) {
          throw new StreamingSttError('VOICE_STT_UNAVAILABLE');
        }
        let written: boolean;
        try {
          written = stream.write({ audio: pcm });
        } catch (err) {
          settleError(err);
          throw settledError ?? mapProviderError(err);
        }
        if (!written) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (error: unknown) => {
              cleanup();
              settleError(error);
              reject(settledError ?? mapProviderError(error));
            };
            const cleanup = () => {
              stream.off('drain', onDrain);
              stream.off('error', onError);
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
          });
        }
      },
      finish: async () => {
        if (!finishRequested) {
          finishRequested = true;
          try {
            stream.end();
          } catch (err) {
            settleError(err);
            throw settledError ?? mapProviderError(err);
          }
        }
        try {
          await completed;
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      },
      cancel: () => {
        stream.cancel();
        settleError(new StreamingSttError('VOICE_CANCELLED'));
        signal?.removeEventListener('abort', onAbort);
      },
    };
  }
}
