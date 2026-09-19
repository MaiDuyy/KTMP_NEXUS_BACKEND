import { StreamingTtsError, type StreamingPcmChunk } from './contracts.js';

export class AsyncAudioQueue implements AsyncIterable<StreamingPcmChunk> {
  private readonly values: StreamingPcmChunk[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<StreamingPcmChunk>) => void;
    reject: (error: Error) => void;
  }> = [];
  private bytes = 0;
  private closed = false;
  private failure: Error | null = null;

  public constructor(private readonly maximumBytes: number) {}

  public push(value: StreamingPcmChunk): void {
    if (this.closed) return;
    if (this.bytes + value.audio.length > this.maximumBytes) {
      const error = new StreamingTtsError('VOICE_TTS_UNAVAILABLE');
      this.close(error);
      throw error;
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
        return new Promise<IteratorResult<StreamingPcmChunk>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
