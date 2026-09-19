import { BatchSttError, type BatchSttProvider, type BatchSttResult } from '../contracts.js';
import { CircuitBreaker, type ProviderResilienceConfig, Resilience } from '../../resilience.js';
import {
  createRequestSignal,
  ElevenLabsHttpError,
  isElevenLabsTransient,
  mapBatchSttError,
} from './elevenLabsCommon.js';

export interface ElevenLabsBatchSttConfig {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  languageCode: string;
  timeoutMs: number;
  maximumInputBytes: number;
}

export class ElevenLabsBatchSttAdapter implements BatchSttProvider {
  public readonly circuitBreaker: CircuitBreaker;

  public constructor(
    private readonly config: ElevenLabsBatchSttConfig,
    resilienceConfig?: ProviderResilienceConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.circuitBreaker = new CircuitBreaker('elevenlabs_stt/batch', {
      failureThreshold: resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public async transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<BatchSttResult> {
    if (signal?.aborted) throw new BatchSttError('VOICE_CANCELLED');
    if (audio.length === 0) throw new BatchSttError('VOICE_NO_SPEECH');
    if (audio.length > this.config.maximumInputBytes) throw new BatchSttError('VOICE_STT_UNAVAILABLE');

    let timedOut = false;
    return Resilience.execute({
      operation: async (remainingBudgetMs) => {
        const requestTimeout = Math.min(this.config.timeoutMs, remainingBudgetMs ?? this.config.timeoutMs);
        const request = createRequestSignal(requestTimeout, signal);
        const form = new FormData();
        form.append('file', new Blob([audio], { type: mimeType }), mimeType.includes('wav') ? 'turn.wav' : 'turn.pcm');
        form.append('model_id', this.config.model);
        form.append('language_code', this.config.languageCode);
        if (mimeType === 'audio/pcm' || mimeType === 'application/octet-stream') {
          form.append('file_format', 'pcm_s16le_16');
        }
        try {
          const response = await this.fetchImpl(`${this.config.apiBaseUrl}/v1/speech-to-text`, {
            method: 'POST',
            headers: { 'xi-api-key': this.config.apiKey },
            body: form,
            signal: request.signal,
          });
          if (!response.ok) throw new ElevenLabsHttpError(response.status);
          const body = await response.json() as { text?: unknown };
          const transcript = typeof body.text === 'string' ? body.text.trim() : '';
          if (!transcript) throw new BatchSttError('VOICE_NO_SPEECH');
          return { transcript, confidence: null };
        } catch (error) {
          timedOut = request.timedOut();
          throw error;
        } finally {
          request.cleanup();
        }
      },
      operationName: 'elevenlabs_stt/batch',
      circuitBreaker: this.circuitBreaker,
      deadlineMs: this.config.timeoutMs,
      retry: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1 },
      signal,
      isTransientError: isElevenLabsTransient,
      mapError: (error, circuitOpen) => circuitOpen
        ? new BatchSttError('VOICE_STT_UNAVAILABLE')
        : mapBatchSttError(error, timedOut),
    });
  }
}
