import type { StreamingPcmChunk } from './googleStreamingTts.js';

export const LIVEKIT_SAMPLE_RATE_HERTZ = 48_000;
export const LIVEKIT_SAMPLES_PER_20MS_FRAME = 960;

export class StreamingPcmError extends Error {
  public constructor(public readonly code: 'VOICE_TTS_UNAVAILABLE' | 'VOICE_LIVEKIT_PUBLISH_FAILED' | 'VOICE_CANCELLED') {
    super(code);
  }
}

export interface Pcm48kResamplerConfig {
  maximumChunkBytes: number;
  maximumTotalInputBytes: number;
}

export interface Pcm48kResamplerSummary {
  inputSamples: number;
  outputSamples: number;
  inputSampleRateHertz: number | null;
}

/**
 * A stateful integer-ratio 24 kHz -> 48 kHz linear interpolator. It retains
 * the final input sample across arbitrary network chunk boundaries, so a
 * different chunk partition produces identical output.
 */
export class Pcm48kResampler {
  private expectedChunkSequence = 0;
  private inputSampleRateHertz: number | null = null;
  private carryByte: number | null = null;
  private previousSample: number | null = null;
  private inputSamples = 0;
  private outputSamples = 0;
  private totalInputBytes = 0;
  private terminal = false;

  public constructor(private readonly config: Pcm48kResamplerConfig) {
    if (!Number.isSafeInteger(config.maximumChunkBytes) || config.maximumChunkBytes < 4
      || !Number.isSafeInteger(config.maximumTotalInputBytes) || config.maximumTotalInputBytes < config.maximumChunkBytes) {
      throw new Error('Invalid PCM resampler configuration');
    }
  }

  public write(chunk: StreamingPcmChunk): Int16Array {
    this.assertActive();
    this.validateChunk(chunk);
    const bytes = this.combineCarry(chunk.audio);
    const samples = this.decodeLittleEndianSamples(bytes);
    this.inputSamples += samples.length;
    return this.resample(samples);
  }

  public finish(): Int16Array {
    this.assertActive();
    this.terminal = true;
    if (this.carryByte !== null) {
      throw new StreamingPcmError('VOICE_TTS_UNAVAILABLE');
    }
    if (this.previousSample === null || this.inputSampleRateHertz === LIVEKIT_SAMPLE_RATE_HERTZ) return new Int16Array(0);
    const tail = new Int16Array([this.previousSample, this.previousSample]);
    this.outputSamples += tail.length;
    this.previousSample = null;
    return tail;
  }

  public cancel(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.carryByte = null;
    this.previousSample = null;
  }

  public summary(): Pcm48kResamplerSummary {
    return {
      inputSamples: this.inputSamples,
      outputSamples: this.outputSamples,
      inputSampleRateHertz: this.inputSampleRateHertz,
    };
  }

  private validateChunk(chunk: StreamingPcmChunk): void {
    if (chunk.segmentSequence !== this.expectedChunkSequence || chunk.encoding !== 'PCM16LE'
      || chunk.channelCount !== 1 || !Number.isSafeInteger(chunk.sampleRateHertz)
      || (chunk.sampleRateHertz !== 24_000 && chunk.sampleRateHertz !== LIVEKIT_SAMPLE_RATE_HERTZ)
      || chunk.audio.length === 0 || chunk.audio.length > this.config.maximumChunkBytes) {
      throw new StreamingPcmError('VOICE_TTS_UNAVAILABLE');
    }
    if (this.inputSampleRateHertz !== null && this.inputSampleRateHertz !== chunk.sampleRateHertz) {
      throw new StreamingPcmError('VOICE_TTS_UNAVAILABLE');
    }
    if (this.expectedChunkSequence === 0 && chunk.audio.subarray(0, 4).toString('ascii') === 'RIFF') {
      throw new StreamingPcmError('VOICE_TTS_UNAVAILABLE');
    }
    this.totalInputBytes += chunk.audio.length;
    if (this.totalInputBytes > this.config.maximumTotalInputBytes) {
      throw new StreamingPcmError('VOICE_TTS_UNAVAILABLE');
    }
    this.inputSampleRateHertz ??= chunk.sampleRateHertz;
    this.expectedChunkSequence += 1;
  }

  private combineCarry(audio: Buffer): Buffer {
    if (this.carryByte === null && audio.length % 2 === 0) return audio;
    const combined = this.carryByte === null ? audio : Buffer.concat([Buffer.from([this.carryByte]), audio]);
    if (combined.length % 2 === 1) {
      this.carryByte = combined[combined.length - 1];
      return combined.subarray(0, combined.length - 1);
    }
    this.carryByte = null;
    return combined;
  }

  private decodeLittleEndianSamples(bytes: Buffer): Int16Array {
    const samples = new Int16Array(bytes.length / 2);
    for (let offset = 0; offset < bytes.length; offset += 2) {
      samples[offset / 2] = bytes.readInt16LE(offset);
    }
    return samples;
  }

  private resample(samples: Int16Array): Int16Array {
    if (this.inputSampleRateHertz === LIVEKIT_SAMPLE_RATE_HERTZ) {
      this.outputSamples += samples.length;
      if (samples.length > 0) this.previousSample = samples[samples.length - 1];
      return samples;
    }
    const output: number[] = [];
    for (const sample of samples) {
      if (this.previousSample !== null) {
        output.push(this.previousSample, Math.round((this.previousSample + sample) / 2));
      }
      this.previousSample = sample;
    }
    const result = Int16Array.from(output);
    this.outputSamples += result.length;
    return result;
  }

  private assertActive(): void {
    if (this.terminal) throw new StreamingPcmError('VOICE_CANCELLED');
  }
}

export interface PcmFrame {
  frameSequence: number;
  data: Int16Array;
  samplesPerChannel: number;
  paddedSamples: number;
}

export interface PcmFrameAssemblerSummary {
  frameCount: number;
  sourceSamples: number;
  paddedSamples: number;
}

export class PcmFrameAssembler {
  private pending: number[] = [];
  private nextFrameSequence = 0;
  private sourceSamples = 0;
  private paddedSamples = 0;
  private terminal = false;

  public constructor(private readonly onFrame: (frame: PcmFrame) => Promise<void>) {}

  public async write(samples: Int16Array): Promise<void> {
    this.assertActive();
    for (const sample of samples) this.pending.push(sample);
    this.sourceSamples += samples.length;
    while (this.pending.length >= LIVEKIT_SAMPLES_PER_20MS_FRAME) {
      await this.emit(this.pending.splice(0, LIVEKIT_SAMPLES_PER_20MS_FRAME), 0);
    }
  }

  public async finish(): Promise<void> {
    this.assertActive();
    this.terminal = true;
    if (this.pending.length === 0) return;
    const sourceLength = this.pending.length;
    const finalFrame = this.pending.splice(0, sourceLength);
    const padded = LIVEKIT_SAMPLES_PER_20MS_FRAME - sourceLength;
    for (let index = 0; index < padded; index += 1) finalFrame.push(0);
    this.paddedSamples += padded;
    await this.emit(finalFrame, padded);
  }

  public cancel(): void {
    this.terminal = true;
    this.pending = [];
  }

  public summary(): PcmFrameAssemblerSummary {
    return { frameCount: this.nextFrameSequence, sourceSamples: this.sourceSamples, paddedSamples: this.paddedSamples };
  }

  private async emit(samples: number[], paddedSamples: number): Promise<void> {
    await this.onFrame({
      frameSequence: this.nextFrameSequence++,
      data: Int16Array.from(samples),
      samplesPerChannel: LIVEKIT_SAMPLES_PER_20MS_FRAME,
      paddedSamples,
    });
  }

  private assertActive(): void {
    if (this.terminal) throw new StreamingPcmError('VOICE_CANCELLED');
  }
}
