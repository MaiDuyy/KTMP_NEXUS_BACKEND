import { BatchSttError, BatchTtsError, StreamingSttError, StreamingTtsError } from '../contracts.js';

export class ElevenLabsHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`ElevenLabs HTTP ${status}`);
    this.name = 'ElevenLabsHttpError';
  }
}

export class ElevenLabsProtocolError extends Error {
  public constructor(public readonly providerCode: string) {
    super('ElevenLabs protocol error');
    this.name = 'ElevenLabsProtocolError';
  }
}

export function sampleRateFromOutputFormat(outputFormat: string): number {
  const match = /^pcm_(\d+)$/.exec(outputFormat);
  if (!match) throw new Error('Unsupported ElevenLabs PCM output format');
  return Number(match[1]);
}

export function wrapPcm16LeAsWav(pcm: Buffer, sampleRateHertz: number): Buffer {
  if (pcm.length === 0 || pcm.length % 2 !== 0) throw new Error('Invalid PCM16 payload');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHertz, 24);
  header.writeUInt32LE(sampleRateHertz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function readResponseBuffer(response: Response, maximumBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ElevenLabsProtocolError('response_too_large');
  }
  if (!response.body) throw new ElevenLabsProtocolError('empty_body');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ElevenLabsProtocolError('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function createRequestSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const onAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
    timedOut: () => timeoutTriggered,
  };
}

function statusCode(error: unknown): number | null {
  return error instanceof ElevenLabsHttpError ? error.status : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'AbortError');
}

export function isElevenLabsTransient(error: unknown): boolean {
  const status = statusCode(error);
  return status !== null ? status >= 500 : !(error instanceof ElevenLabsProtocolError) && !isAbortError(error);
}

export function mapBatchSttError(error: unknown, timedOut = false): BatchSttError {
  if (error instanceof BatchSttError) return error;
  const status = statusCode(error);
  if (status === 429) return new BatchSttError('VOICE_STT_QUOTA_EXCEEDED');
  if (timedOut || status === 408) return new BatchSttError('VOICE_STT_TIMEOUT');
  if (isAbortError(error)) return new BatchSttError('VOICE_CANCELLED');
  return new BatchSttError('VOICE_STT_UNAVAILABLE');
}

export function mapBatchTtsError(error: unknown, timedOut = false): BatchTtsError {
  if (error instanceof BatchTtsError) return error;
  const status = statusCode(error);
  if (status === 429) return new BatchTtsError('VOICE_TTS_QUOTA_EXCEEDED');
  if (timedOut || status === 408) return new BatchTtsError('VOICE_TTS_TIMEOUT');
  if (isAbortError(error)) return new BatchTtsError('VOICE_CANCELLED');
  return new BatchTtsError('VOICE_TTS_UNAVAILABLE');
}

export function mapStreamingSttError(error: unknown): StreamingSttError {
  if (error instanceof StreamingSttError) return error;
  const status = statusCode(error);
  const code = error instanceof ElevenLabsProtocolError ? error.providerCode : status;
  if (status === 429 || code === 'quota_exceeded' || code === 'rate_limited') {
    return new StreamingSttError('VOICE_STT_QUOTA_EXCEEDED', code);
  }
  if (code === 'timeout') return new StreamingSttError('VOICE_STT_TIMEOUT', code);
  if (isAbortError(error) || code === 'cancelled') return new StreamingSttError('VOICE_CANCELLED', code);
  return new StreamingSttError('VOICE_STT_UNAVAILABLE', code);
}

export function mapStreamingTtsError(error: unknown): StreamingTtsError {
  if (error instanceof StreamingTtsError) return error;
  const status = statusCode(error);
  const code = error instanceof ElevenLabsProtocolError ? error.providerCode : status;
  if (status === 429 || code === 'quota_exceeded' || code === 'rate_limited') {
    return new StreamingTtsError('VOICE_TTS_QUOTA_EXCEEDED', code);
  }
  if (code === 'timeout') return new StreamingTtsError('VOICE_TTS_TIMEOUT', code);
  if (isAbortError(error) || code === 'cancelled') return new StreamingTtsError('VOICE_CANCELLED', code);
  return new StreamingTtsError('VOICE_TTS_UNAVAILABLE', code);
}
