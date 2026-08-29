import assert from "node:assert/strict";
import test from "node:test";
import { parseWav } from "./wavParser.js";
import { BatchTtsResult } from "./batchTts.js";

function createWavHeader(dataSize: number, channels: number = 1, sampleRate: number = 24000, bitsPerSample: number = 16, audioFormat: number = 1): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(audioFormat, 20); // audio format
  buffer.writeUInt16LE(channels, 22); // num channels
  buffer.writeUInt32LE(sampleRate, 24); // sample rate
  buffer.writeUInt32LE(byteRate, 28); // byte rate
  buffer.writeUInt16LE(blockAlign, 32); // block align
  buffer.writeUInt16LE(bitsPerSample, 34); // bits per sample

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

test("wavParser - parses correctly", () => {
  const wav = createWavHeader(4); // 2 samples
  wav.writeInt16LE(1234, 44);
  wav.writeInt16LE(-5678, 46);

  const result = parseWav({
    audio: wav,
    sampleRateHertz: 24000,
    contentType: 'audio/wav',
    encoding: 'LINEAR16',
    channelCount: 1
  } as BatchTtsResult);

  assert.equal(result.sampleRate, 24000);
  assert.equal(result.channels, 1);
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples[0], 1234);
  assert.equal(result.samples[1], -5678);
});

test("wavParser - handles odd chunk size padding", () => {
  // Add an odd-sized custom chunk before data
  const customChunk = Buffer.alloc(8 + 5);
  customChunk.write("cust", 0);
  customChunk.writeUInt32LE(5, 4);
  customChunk.write("12345", 8);
  // Padding byte
  const padding = Buffer.alloc(1);
  padding.writeUInt8(0, 0);

  const header = createWavHeader(4);
  // Split at offset 36 (before data)
  const part1 = header.subarray(0, 36);
  const part2 = header.subarray(36);

  // RIFF size needs to be adjusted
  const newSize = 36 + 4 + 8 + 6; // old stuff + data + custom + pad
  part1.writeUInt32LE(newSize, 4);

  const wav = Buffer.concat([part1, customChunk, padding, part2]);
  wav.writeInt16LE(1234, wav.length - 4);
  wav.writeInt16LE(5678, wav.length - 2);

  const result = parseWav({
    audio: wav,
    sampleRateHertz: 24000,
    contentType: 'audio/wav',
    encoding: 'LINEAR16',
    channelCount: 1
  } as BatchTtsResult);

  assert.equal(result.sampleRate, 24000);
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples[0], 1234);
  assert.equal(result.samples[1], 5678);
});

test("wavParser - rejects bad format", () => {
  const wav = createWavHeader(4, 2); // 2 channels
  assert.throws(() => parseWav({ audio: wav, sampleRateHertz: 24000, contentType: 'audio/wav', encoding: 'LINEAR16', channelCount: 1 } as BatchTtsResult), /Only mono/);

  const wav2 = createWavHeader(4, 1, 24000, 8); // 8-bit
  assert.throws(() => parseWav({ audio: wav2, sampleRateHertz: 24000, contentType: 'audio/wav', encoding: 'LINEAR16', channelCount: 1 } as BatchTtsResult), /Only 16-bit/);

  const wav3 = createWavHeader(4, 1, 24000, 16, 3); // Float format
  assert.throws(() => parseWav({ audio: wav3, sampleRateHertz: 24000, contentType: 'audio/wav', encoding: 'LINEAR16', channelCount: 1 } as BatchTtsResult), /Only PCM format 1/);
});

test("wavParser - rejects sample rate mismatch", () => {
  const wav = createWavHeader(4, 1, 16000);
  assert.throws(() => parseWav({ audio: wav, sampleRateHertz: 24000, contentType: 'audio/wav', encoding: 'LINEAR16', channelCount: 1 } as BatchTtsResult), /Sample rate mismatch/);
});

test("wavParser - rejects missing chunks or truncated", () => {
  const wav = createWavHeader(4);

  // Truncate inside the data chunk payload
  assert.throws(() => parseWav({ audio: wav.subarray(0, 46), sampleRateHertz: 24000, contentType: 'audio/wav', encoding: 'LINEAR16', channelCount: 1 } as BatchTtsResult), /Truncated/);

  // Truncate before data chunk header can be read
  assert.throws(() => parseWav({ audio: wav.subarray(0, 42), sampleRateHertz: 24000, contentType: 'audio/wav', encoding: 'LINEAR16', channelCount: 1 } as BatchTtsResult), /Missing fmt or data chunk/);

  const noData = wav.subarray(0, 36);
  noData.writeUInt32LE(36 - 8, 4);
  assert.throws(() => parseWav({ audio: noData, sampleRateHertz: 24000, contentType: 'audio/wav', encoding: 'LINEAR16', channelCount: 1 } as BatchTtsResult), /Missing fmt or data/);

  const oddData = createWavHeader(3);
  assert.throws(
    () => parseWav({ audio: oddData, sampleRateHertz: 24000, contentType: 'audio/wav', encoding: 'LINEAR16', channelCount: 1 } as BatchTtsResult),
    /data chunk size/,
  );
});
