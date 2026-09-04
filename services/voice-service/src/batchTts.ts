import { TextToSpeechClient } from "@google-cloud/text-to-speech";

export interface BatchTtsResult {
  audio: Buffer;
  contentType: string;
  encoding: string;
  sampleRateHertz: number;
  channelCount: number;
}

export interface TtsProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<BatchTtsResult>;
}

export interface GoogleBatchTtsConfig {
  projectId: string;
  location: string;
  voiceName: string;
  audioEncoding: string;
  timeoutMs: number;
}

export class BatchTtsError extends Error {
  public constructor(
    public readonly code: "VOICE_TTS_TIMEOUT" | "VOICE_TTS_UNAVAILABLE" | "VOICE_TTS_QUOTA_EXCEEDED" | "VOICE_CANCELLED" | "VOICE_NO_SPEECH" | "VOICE_SPEECH_TOO_LONG"
  ) {
    super(code);
  }
}

export interface TextToSpeechSynthesizerClient {
  synthesizeSpeech(request: any, options: { timeout: number }): Promise<[any]>;
}

import { CircuitBreaker, ProviderResilienceConfig, Resilience } from './resilience.js';

export class GoogleBatchTtsAdapter implements TtsProvider {
  public readonly circuitBreaker: CircuitBreaker;
  private readonly client: TextToSpeechSynthesizerClient;
  private readonly resilienceConfig?: ProviderResilienceConfig;

  public constructor(
    private readonly config: GoogleBatchTtsConfig,
    clientOrResilience?: TextToSpeechSynthesizerClient | ProviderResilienceConfig,
    resilienceConfig?: ProviderResilienceConfig,
  ) {
    if (clientOrResilience && 'synthesizeSpeech' in clientOrResilience) {
      this.client = clientOrResilience;
      this.resilienceConfig = resilienceConfig;
    } else {
      this.resilienceConfig = clientOrResilience;
      this.client = new TextToSpeechClient({
        projectId: config.projectId,
        apiEndpoint: config.location && config.location !== "global" ? `${config.location}-texttospeech.googleapis.com` : undefined
      }) as unknown as TextToSpeechSynthesizerClient;
    }
    this.circuitBreaker = new CircuitBreaker('google_tts/batch', {
      failureThreshold: this.resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: this.resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: this.resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: this.resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public async synthesize(text: string, signal?: AbortSignal): Promise<BatchTtsResult> {
    if (signal?.aborted) {
      throw new BatchTtsError("VOICE_CANCELLED");
    }

    const cleanText = text.trim();
    if (!cleanText) {
      throw new BatchTtsError("VOICE_NO_SPEECH");
    }
    if (cleanText.length > 5000) {
      throw new BatchTtsError("VOICE_SPEECH_TOO_LONG");
    }

    if (this.config.audioEncoding !== "LINEAR16") {
      throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
    }

    const languageCode = this.config.voiceName.split("-").slice(0, 2).join("-");
    const request = {
      input: { text: cleanText },
      voice: { name: this.config.voiceName, languageCode },
      audioConfig: { audioEncoding: this.config.audioEncoding },
    };

    return Resilience.execute({
      operation: async (remainingBudgetMs) => {
        const callTimeout = remainingBudgetMs !== undefined ? Math.min(this.config.timeoutMs, remainingBudgetMs) : this.config.timeoutMs;
        const promise = this.client.synthesizeSpeech(request, { timeout: callTimeout });
        let response: any;
        if (signal) {
          response = await new Promise((resolve, reject) => {
            let isDone = false;
            const onAbort = () => {
              if (isDone) return;
              isDone = true;
              signal.removeEventListener("abort", onAbort);
              reject(new BatchTtsError("VOICE_CANCELLED"));
            };
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
            promise.then(
              (res) => { if (isDone) return; isDone = true; signal.removeEventListener("abort", onAbort); resolve(res[0]); },
              (err) => { if (isDone) return; isDone = true; signal.removeEventListener("abort", onAbort); reject(err); }
            );
          });
        } else {
          const res = await promise;
          response = res[0];
        }

        if (!response || !response.audioContent) {
          throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
        }

        const audioBuffer = Buffer.from(response.audioContent);
        if (audioBuffer.length < 44 || audioBuffer.toString('utf8', 0, 4) !== 'RIFF' || audioBuffer.toString('utf8', 8, 12) !== 'WAVE') {
          throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
        }

        let contentType = "audio/wav";
        let sampleRateHertz = 0;
        let channelCount = 0;

        let offset = 12;
        let foundFmt = false;
        while (offset + 8 <= audioBuffer.length) {
          const chunkId = audioBuffer.toString('utf8', offset, offset + 4);
          const chunkSize = audioBuffer.readUInt32LE(offset + 4);
          if (chunkId === 'fmt ') {
            if (chunkSize < 16 || offset + 8 + chunkSize > audioBuffer.length) break;
            channelCount = audioBuffer.readUInt16LE(offset + 8 + 2);
            sampleRateHertz = audioBuffer.readUInt32LE(offset + 8 + 4);
            foundFmt = true;
            break;
          }
          offset += 8 + chunkSize;
        }

        if (!foundFmt || sampleRateHertz === 0 || channelCount === 0) {
          throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
        }

        return {
          audio: audioBuffer,
          contentType,
          encoding: this.config.audioEncoding,
          sampleRateHertz,
          channelCount,
        };
      },
      operationName: 'google_tts/batch',
      circuitBreaker: this.circuitBreaker,
      deadlineMs: this.config.timeoutMs * 2,
      retry: {
        maxAttempts: this.resilienceConfig?.providerMaxRetryAttempts ?? 2,
        baseBackoffMs: this.resilienceConfig?.providerRetryBaseBackoffMs ?? 200,
        maxBackoffMs: this.resilienceConfig?.providerRetryMaxBackoffMs ?? 2000,
      },
      signal,
      isTransientError: (err: any) => {
        if (err instanceof BatchTtsError) return false;
        const code = err?.code;
        return code === 4 || code === 'DEADLINE_EXCEEDED' || code === 14 || code === 'UNAVAILABLE' || code === 13 || code === 'INTERNAL';
      },
      mapError: (err: any, circuitOpen: boolean) => {
        if (err instanceof BatchTtsError) return err;
        if (circuitOpen) return new BatchTtsError("VOICE_TTS_UNAVAILABLE");
        if (err?.message === 'DeadlineExceeded') return new BatchTtsError("VOICE_TTS_TIMEOUT");
        const code = err?.code;
        if (code === 8 || code === 'RESOURCE_EXHAUSTED') return new BatchTtsError("VOICE_TTS_QUOTA_EXCEEDED");
        if (code === 4 || code === "DEADLINE_EXCEEDED") return new BatchTtsError("VOICE_TTS_TIMEOUT");
        if (err?.message === 'AbortError' || err?.code === 1 || err?.code === 'CANCELLED') return new BatchTtsError("VOICE_CANCELLED");
        return new BatchTtsError("VOICE_TTS_UNAVAILABLE");
      }
    });
  }
}
