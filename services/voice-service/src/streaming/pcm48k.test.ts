import assert from 'node:assert/strict';
import test from 'node:test';
import { Pcm48kResampler, PcmFrameAssembler, LIVEKIT_SAMPLES_PER_20MS_FRAME, StreamingPcmError } from './pcm48k.js';

function pcm(samples: readonly number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

function chunk(sequence: number, audio: Buffer) {
  return { segmentSequence: sequence, audio, encoding: 'PCM16LE' as const, sampleRateHertz: 24_000, channelCount: 1 as const, receivedAtMs: 1 };
}

function resample(parts: Buffer[]): number[] {
  const resampler = new Pcm48kResampler({ maximumChunkBytes: 100_000, maximumTotalInputBytes: 1_000_000 });
  const output = parts.flatMap((part, sequence) => [...resampler.write(chunk(sequence, part))]);
  output.push(...resampler.finish());
  return output;
}

test('statefully up-samples 24 kHz PCM with deterministic linear interpolation', () => {
  assert.deepEqual(resample([pcm([100, 300, -100])]), [100, 200, 300, 100, -100, -100]);
  assert.deepEqual(resample([pcm([100]), pcm([300, -100])]), [100, 200, 300, 100, -100, -100]);
});

test('preserves output when input is partitioned at odd byte boundaries', () => {
  const source = pcm([1, 2, 3, 4, 5, 6, 7, 8]);
  const oneChunk = resample([source]);
  const oddChunks = resample([source.subarray(0, 1), source.subarray(1, 7), source.subarray(7)]);
  assert.deepEqual(oddChunks, oneChunk);
});

test('rejects malformed metadata, sequence gaps, RIFF headers, and terminal dangling bytes', () => {
  const resampler = new Pcm48kResampler({ maximumChunkBytes: 100, maximumTotalInputBytes: 100 });
  assert.throws(() => resampler.write({ ...chunk(1, pcm([1])), segmentSequence: 1 }), StreamingPcmError);
  const riff = Buffer.from('RIFFfake');
  assert.throws(() => new Pcm48kResampler({ maximumChunkBytes: 100, maximumTotalInputBytes: 100 }).write(chunk(0, riff)), StreamingPcmError);
  const dangling = new Pcm48kResampler({ maximumChunkBytes: 100, maximumTotalInputBytes: 100 });
  dangling.write(chunk(0, Buffer.from([1])));
  assert.throws(() => dangling.finish(), StreamingPcmError);
});

test('assembles exact 20 ms frames and pads only the final frame', async () => {
  const frames: { sequence: number; samples: number; padded: number }[] = [];
  const assembler = new PcmFrameAssembler(async (frame) => {
    frames.push({ sequence: frame.frameSequence, samples: frame.data.length, padded: frame.paddedSamples });
  });
  await assembler.write(Int16Array.from({ length: LIVEKIT_SAMPLES_PER_20MS_FRAME + 10 }, (_, index) => index));
  await assembler.finish();
  assert.deepEqual(frames, [
    { sequence: 0, samples: 960, padded: 0 },
    { sequence: 1, samples: 960, padded: 950 },
  ]);
  assert.deepEqual(assembler.summary(), { frameCount: 2, sourceSamples: 970, paddedSamples: 950 });
});

test('keeps the exact 2:1 sample count through 60 seconds of synthetic 24 kHz PCM', () => {
  const sampleCount = 24_000 * 60;
  const audio = Buffer.alloc(sampleCount * 2);
  const resampler = new Pcm48kResampler({ maximumChunkBytes: audio.length, maximumTotalInputBytes: audio.length });
  const output = resampler.write(chunk(0, audio));
  const tail = resampler.finish();
  assert.equal(output.length + tail.length, 48_000 * 60);
  assert.deepEqual(resampler.summary(), { inputSamples: sampleCount, outputSamples: 48_000 * 60, inputSampleRateHertz: 24_000 });
});
