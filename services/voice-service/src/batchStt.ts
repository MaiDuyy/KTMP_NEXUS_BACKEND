import { v2 } from "@google-cloud/speech";

export interface BatchSttConfig { projectId: string; location: string; model: string; languageCode: string; timeoutMs: number; }
export interface BatchSttResult { transcript: string; confidence: number | null; }
export interface SpeechRecognizerClient { recognize(request: unknown, options: { timeout: number }): Promise<[any]>; }

export class BatchSttError extends Error { public constructor(public readonly code: "VOICE_NO_SPEECH" | "VOICE_STT_TIMEOUT" | "VOICE_STT_UNAVAILABLE" | "VOICE_STT_QUOTA_EXCEEDED" | "VOICE_CANCELLED") { super(code); } }

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new BatchSttError('VOICE_CANCELLED'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BatchSttError('VOICE_CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

import { CircuitBreaker, ProviderResilienceConfig, Resilience } from './resilience.js';

export class GoogleBatchSttAdapter {
  public readonly circuitBreaker: CircuitBreaker;
  private readonly client: SpeechRecognizerClient;
  private readonly resilienceConfig?: ProviderResilienceConfig;

  public constructor(
    private readonly config: BatchSttConfig,
    clientOrResilience?: SpeechRecognizerClient | ProviderResilienceConfig,
    resilienceConfig?: ProviderResilienceConfig,
  ) {
    if (clientOrResilience && 'recognize' in clientOrResilience) {
      this.client = clientOrResilience;
      this.resilienceConfig = resilienceConfig;
    } else {
      this.resilienceConfig = clientOrResilience;
      this.client = new v2.SpeechClient({
        projectId: config.projectId,
        apiEndpoint: config.location && config.location !== "global"
          ? config.location + "-speech.googleapis.com"
          : undefined,
      }) as unknown as SpeechRecognizerClient;
    }
    this.circuitBreaker = new CircuitBreaker('google_stt/batch', {
      failureThreshold: this.resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: this.resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: this.resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: this.resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public async transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<BatchSttResult> {
    return Resilience.execute({
      operation: async (remainingBudgetMs) => {
        const callTimeout = remainingBudgetMs !== undefined ? Math.min(this.config.timeoutMs, remainingBudgetMs) : this.config.timeoutMs;
        const recognition = this.client.recognize({
          recognizer: `projects/${this.config.projectId}/locations/${this.config.location}/recognizers/_`,
          config: { autoDecodingConfig: {}, languageCodes: [this.config.languageCode], model: this.config.model },
          content: audio,
        }, { timeout: callTimeout });

        const [response] = await withAbort(recognition, signal);
        const alternatives = response.results?.flatMap((result: any) => result.alternatives ?? []) ?? [];
        const transcript = alternatives.map((alternative: any) => alternative.transcript ?? "").join(" ").trim();
        if (!transcript) throw new BatchSttError("VOICE_NO_SPEECH");
        const confidence = alternatives.find((alternative: any) => typeof alternative.confidence === "number")?.confidence ?? null;
        return { transcript, confidence };
      },
      operationName: 'google_stt/batch',
      circuitBreaker: this.circuitBreaker,
      deadlineMs: this.config.timeoutMs * 2,
      retry: {
        maxAttempts: this.resilienceConfig?.providerMaxRetryAttempts ?? 2,
        baseBackoffMs: this.resilienceConfig?.providerRetryBaseBackoffMs ?? 200,
        maxBackoffMs: this.resilienceConfig?.providerRetryMaxBackoffMs ?? 2000,
      },
      signal,
      isTransientError: (err: any) => {
        if (err instanceof BatchSttError) return false;
        const code = err?.code;
        return code === 4 || code === 'DEADLINE_EXCEEDED' || code === 14 || code === 'UNAVAILABLE' || code === 13 || code === 'INTERNAL';
      },
      mapError: (err: any, circuitOpen: boolean) => {
        if (err instanceof BatchSttError) return err;
        if (circuitOpen) return new BatchSttError("VOICE_STT_UNAVAILABLE");
        if (err?.message === 'DeadlineExceeded') return new BatchSttError("VOICE_STT_TIMEOUT");
        const code = err?.code;
        if (code === 8 || code === 'RESOURCE_EXHAUSTED') return new BatchSttError("VOICE_STT_QUOTA_EXCEEDED");
        if (code === 4 || code === "DEADLINE_EXCEEDED") return new BatchSttError("VOICE_STT_TIMEOUT");
        if (err?.message === 'AbortError' || err?.code === 1 || err?.code === 'CANCELLED') return new BatchSttError("VOICE_CANCELLED");
        return new BatchSttError("VOICE_STT_UNAVAILABLE");
      }
    });
  }
}
