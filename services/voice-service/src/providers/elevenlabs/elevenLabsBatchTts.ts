import { BatchTtsError, type BatchTtsProvider, type BatchTtsResult } from '../contracts.js';
import { CircuitBreaker, type ProviderResilienceConfig, Resilience } from '../../resilience.js';
import {
  createRequestSignal,
  ElevenLabsHttpError,
  isElevenLabsTransient,
  mapBatchTtsError,
  readResponseBuffer,
  sampleRateFromOutputFormat,
  wrapPcm16LeAsWav,
} from './elevenLabsCommon.js';

export interface ElevenLabsBatchTtsConfig {
  apiKey: string;
  apiBaseUrl: string;
  voiceId: string;
  model: string;
  languageCode: string;
  outputFormat: string;
  timeoutMs: number;
  maximumOutputBytes: number;
}

export class ElevenLabsBatchTtsAdapter implements BatchTtsProvider {
  public readonly circuitBreaker: CircuitBreaker;

  public constructor(
    private readonly config: ElevenLabsBatchTtsConfig,
    resilienceConfig?: ProviderResilienceConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.circuitBreaker = new CircuitBreaker('elevenlabs_tts/batch', {
      failureThreshold: resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public async synthesize(text: string, signal?: AbortSignal): Promise<BatchTtsResult> {
    if (signal?.aborted) throw new BatchTtsError('VOICE_CANCELLED');
    const cleanText = text.trim();
    if (!cleanText) throw new BatchTtsError('VOICE_NO_SPEECH');
    if (cleanText.length > 5_000) throw new BatchTtsError('VOICE_SPEECH_TOO_LONG');
    const sampleRateHertz = sampleRateFromOutputFormat(this.config.outputFormat);
    let timedOut = false;

    return Resilience.execute({
      operation: async (remainingBudgetMs) => {
        const requestTimeout = Math.min(this.config.timeoutMs, remainingBudgetMs ?? this.config.timeoutMs);
        const request = createRequestSignal(requestTimeout, signal);
        const url = new URL(`${this.config.apiBaseUrl}/v1/text-to-speech/${encodeURIComponent(this.config.voiceId)}/stream`);
        url.searchParams.set('output_format', this.config.outputFormat);
        try {
          const response = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'xi-api-key': this.config.apiKey },
            body: JSON.stringify({
              text: cleanText,
              model_id: this.config.model,
              language_code: this.config.languageCode,
            }),
            signal: request.signal,
          });
          if (!response.ok) throw new ElevenLabsHttpError(response.status);
          const pcm = await readResponseBuffer(response, this.config.maximumOutputBytes);
          const wav = wrapPcm16LeAsWav(pcm, sampleRateHertz);
          return {
            audio: wav,
            contentType: 'audio/wav',
            encoding: 'LINEAR16',
            sampleRateHertz,
            channelCount: 1,
          };
        } catch (error) {
          timedOut = request.timedOut();
          throw error;
        } finally {
          request.cleanup();
        }
      },
      operationName: 'elevenlabs_tts/batch',
      circuitBreaker: this.circuitBreaker,
      deadlineMs: this.config.timeoutMs,
      retry: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1 },
      signal,
      isTransientError: isElevenLabsTransient,
      mapError: (error, circuitOpen) => circuitOpen
        ? new BatchTtsError('VOICE_TTS_UNAVAILABLE')
        : mapBatchTtsError(error, timedOut),
    });
  }
}
