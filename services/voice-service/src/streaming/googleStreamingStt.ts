import { v2 } from '@google-cloud/speech';
import type { CancellableStream } from 'google-gax';

export interface StreamingSttConfig {
  projectId: string;
  location: string;
  model: string;
  languageCode: string;
  timeoutMs: number;
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

export class StreamingSttError extends Error {
  public constructor(
    public readonly code: 'VOICE_STT_TIMEOUT' | 'VOICE_STT_UNAVAILABLE' | 'VOICE_CANCELLED',
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
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message.slice(0, 500) : null;
  if (code === 4 || code === 'DEADLINE_EXCEEDED') return new StreamingSttError('VOICE_STT_TIMEOUT', code, message);
  if (code === 1 || code === 'CANCELLED') return new StreamingSttError('VOICE_CANCELLED', code, message);
  return new StreamingSttError(
    'VOICE_STT_UNAVAILABLE',
    typeof code === 'string' || typeof code === 'number' ? code : null,
    message,
  );
}

export class GoogleStreamingSttAdapter {
  public constructor(
    private readonly config: StreamingSttConfig,
    private readonly client: StreamingSpeechClient = new v2.SpeechClient({
      projectId: config.projectId,
      apiEndpoint: config.location && config.location !== 'global'
        ? `${config.location}-speech.googleapis.com`
        : undefined,
    }) as unknown as StreamingSpeechClient,
  ) {}

  public open(callbacks: StreamingSttCallbacks, signal?: AbortSignal): StreamingSttSession {
    const stream = this.client._streamingRecognize({ timeout: this.config.timeoutMs });
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
      resolveCompleted();
    };
    const settleError = (error: unknown) => {
      if (settled) return;
      settled = true;
      settledError = mapProviderError(error);
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
    stream.once('end', settleSuccess);
    stream.once('close', () => {
      if (finishRequested) settleSuccess();
    });
    signal?.addEventListener('abort', onAbort, { once: true });

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
        },
        streamingFeatures: { interimResults: true },
      },
    });

    return {
      write: async (pcm) => {
        if (settled) throw settledError ?? new StreamingSttError('VOICE_CANCELLED');
        if (finishRequested || signal?.aborted) throw new StreamingSttError('VOICE_CANCELLED');
        if (pcm.length === 0 || pcm.length > 15_000 || pcm.length % 2 !== 0) {
          throw new StreamingSttError('VOICE_STT_UNAVAILABLE');
        }
        if (!stream.write({ audio: pcm })) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (error: unknown) => { cleanup(); reject(mapProviderError(error)); };
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
          stream.end();
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
