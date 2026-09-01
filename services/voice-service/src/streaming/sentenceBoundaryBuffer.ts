export type SpeechSegmentFlushReason = 'punctuation' | 'length' | 'timeout' | 'done';

export interface SpeechSegment {
  turnId: string;
  segmentSequence: number;
  text: string;
  reason: SpeechSegmentFlushReason;
}

export interface SpeechDelta {
  turnId: string;
  sequence: number;
  text: string;
}

export interface SentenceBoundaryBufferConfig {
  minimumChars: number;
  targetChars: number;
  maximumChars: number;
  flushTimeoutMs: number;
  maximumBytes: number;
}

export interface SentenceBoundaryBufferOptions {
  turnId: string;
  config: SentenceBoundaryBufferConfig;
  onSegment: (segment: SpeechSegment) => void | Promise<void>;
  signal?: AbortSignal;
}

export class SentenceBoundaryBuffer {
  private pending = '';
  private sequence = 0;
  private terminal = false;
  private expectedDeltaSequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delivery: Promise<void> = Promise.resolve();
  private readonly onAbort = () => { void this.cancel(); };

  public constructor(private readonly options: SentenceBoundaryBufferOptions) {
    const { minimumChars, targetChars, maximumChars, flushTimeoutMs, maximumBytes } = options.config;
    if (!Number.isInteger(minimumChars) || !Number.isInteger(targetChars) || !Number.isInteger(maximumChars)
      || minimumChars < 1 || targetChars < minimumChars || maximumChars < targetChars
      || !Number.isInteger(flushTimeoutMs) || flushTimeoutMs < 1
      || !Number.isInteger(maximumBytes) || maximumBytes < 4) {
      throw new Error('Invalid streaming sentence buffer configuration');
    }
    if (options.signal?.aborted) {
      this.terminal = true;
    } else {
      options.signal?.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  public async push(delta: SpeechDelta): Promise<void> {
    this.assertActive();
    if (delta.turnId !== this.options.turnId || !Number.isSafeInteger(delta.sequence) || delta.sequence !== this.expectedDeltaSequence) {
      throw new Error('Streaming sentence buffer received an invalid delta sequence');
    }
    this.expectedDeltaSequence += 1;
    const normalized = delta.text
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\r\n]+/g, ' ')
      .replace(/ *\n */g, '\n');
    if (!normalized) return;
    this.pending += normalized;
    await this.flushAvailable();
    this.armTimer();
  }

  public async finish(): Promise<void> {
    if (this.terminal) return;
    this.terminal = true;
    this.clearTimer();
    await this.flush('done');
    await this.delivery;
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }

  public async cancel(): Promise<void> {
    if (this.terminal) return;
    this.terminal = true;
    this.pending = '';
    this.clearTimer();
    await this.delivery;
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }

  private async flushAvailable(): Promise<void> {
    while (this.pending.length >= this.options.config.minimumChars) {
      const boundary = this.findSentenceBoundary();
      if (boundary > 0) {
        await this.emit(this.pending.slice(0, boundary).trimEnd(), 'punctuation');
        this.pending = this.pending.slice(boundary).trimStart();
        continue;
      }
      if (this.pending.length >= this.options.config.maximumChars || Buffer.byteLength(this.pending, 'utf8') > this.options.config.maximumBytes) {
        const splitAt = this.findLengthBoundary();
        await this.emit(this.pending.slice(0, splitAt).trimEnd(), 'length');
        this.pending = this.pending.slice(splitAt).trimStart();
        continue;
      }
      break;
    }
  }

  private findSentenceBoundary(): number {
    const limit = Math.min(this.pending.length, this.options.config.maximumChars);
    for (let index = this.options.config.minimumChars - 1; index < limit; index += 1) {
      const character = this.pending[index];
      if (character === '\n') return index + 1;
      if (!'.!?;:'.includes(character) || !this.isSentencePunctuation(index)) continue;
      return index + 1;
    }
    return -1;
  }

  private isSentencePunctuation(index: number): boolean {
    const character = this.pending[index];
    if (character !== '.') return true;
    const before = this.pending[index - 1] ?? '';
    const after = this.pending[index + 1] ?? '';
    if (/\d/.test(before) && /\d/.test(after)) return false;
    const previousWord = this.pending.slice(0, index).match(/([A-Za-z]{1,4})$/)?.[1]?.toLowerCase();
    return !['mr', 'mrs', 'ms', 'dr', 'vs', 'etc', 'e.g', 'i.e'].includes(previousWord ?? '');
  }

  private findLengthBoundary(): number {
    const hardLimit = Math.min(this.pending.length, this.options.config.maximumChars);
    const byteLimit = this.takeWithinByteLimit(hardLimit);
    const preferred = Math.min(byteLimit, this.options.config.targetChars);
    for (let index = preferred; index > this.options.config.minimumChars; index -= 1) {
      if (/\s/.test(this.pending[index])) return index + 1;
    }
    return Math.max(1, byteLimit);
  }

  private takeWithinByteLimit(limit: number): number {
    let index = 0;
    let bytes = 0;
    while (index < limit) {
      const codePoint = this.pending.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const size = Buffer.byteLength(character, 'utf8');
      if (bytes + size > this.options.config.maximumBytes) break;
      bytes += size;
      index += character.length;
    }
    return index;
  }

  private async flush(reason: SpeechSegmentFlushReason): Promise<void> {
    const text = this.pending.trim();
    this.pending = '';
    if (text) await this.emit(text, reason);
  }

  private async emit(text: string, reason: SpeechSegmentFlushReason): Promise<void> {
    const segment: SpeechSegment = {
      turnId: this.options.turnId,
      segmentSequence: this.sequence++,
      text,
      reason,
    };
    this.delivery = this.delivery.then(() => this.options.onSegment(segment));
    await this.delivery;
  }

  private armTimer(): void {
    this.clearTimer();
    if (!this.pending) return;
    this.timer = setTimeout(() => {
      if (!this.terminal) void this.flush('timeout').catch(() => this.cancel());
    }, this.options.config.flushTimeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private assertActive(): void {
    if (this.terminal) throw new Error('Streaming sentence buffer is terminal');
  }
}
