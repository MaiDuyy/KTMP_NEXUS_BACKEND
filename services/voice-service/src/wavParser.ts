import { BatchTtsResult } from "./batchTts.js";

export interface ParsedWav {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

export function parseWav(audio: BatchTtsResult): ParsedWav {
  if (audio.contentType !== "audio/wav") {
    throw new Error(`VOICE_LIVEKIT_PUBLISH_FAILED: Invalid content type, expected audio/wav, got ${audio.contentType}`);
  }
  if (audio.encoding !== "LINEAR16") {
    throw new Error(`VOICE_LIVEKIT_PUBLISH_FAILED: Invalid encoding, expected LINEAR16, got ${audio.encoding}`);
  }
  if (audio.channelCount !== 1) {
    throw new Error(`VOICE_LIVEKIT_PUBLISH_FAILED: Invalid channel count, expected 1, got ${audio.channelCount}`);
  }

  const buffer = audio.audio;

  if (buffer.length < 12) {
    throw new Error("VOICE_LIVEKIT_PUBLISH_FAILED: Buffer too small for RIFF header");
  }

  const riffId = buffer.toString("ascii", 0, 4);
  if (riffId !== "RIFF") {
    throw new Error("VOICE_LIVEKIT_PUBLISH_FAILED: Missing RIFF header");
  }

  const waveId = buffer.toString("ascii", 8, 12);
  if (waveId !== "WAVE") {
    throw new Error("VOICE_LIVEKIT_PUBLISH_FAILED: Missing WAVE format");
  }

  let offset = 12;
  let fmtFound = false;
  let dataFound = false;
  let sampleRate = 0;
  let channels = 0;
  let samples = new Int16Array(0);

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (offset + 8 + chunkSize > buffer.length) {
      throw new Error("VOICE_LIVEKIT_PUBLISH_FAILED: Truncated chunk");
    }

    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        throw new Error("VOICE_LIVEKIT_PUBLISH_FAILED: Invalid fmt chunk size");
      }
      const audioFormat = buffer.readUInt16LE(offset + 8);
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      const bitsPerSample = buffer.readUInt16LE(offset + 22);

      if (audioFormat !== 1) {
        throw new Error(`VOICE_LIVEKIT_PUBLISH_FAILED: Only PCM format 1 is supported, got ${audioFormat}`);
      }
      if (channels !== 1) {
        throw new Error(`VOICE_LIVEKIT_PUBLISH_FAILED: Only mono audio is supported, got ${channels}`);
      }
      if (bitsPerSample !== 16) {
        throw new Error(`VOICE_LIVEKIT_PUBLISH_FAILED: Only 16-bit audio is supported, got ${bitsPerSample}`);
      }
      fmtFound = true;
    } else if (chunkId === "data") {
      if (chunkSize % 2 !== 0) {
        throw new Error("VOICE_LIVEKIT_PUBLISH_FAILED: Invalid data chunk size (must be even)");
      }
      dataFound = true;
      const chunkBuffer = buffer.subarray(offset + 8, offset + 8 + chunkSize);
      // Copy to avoid exposing the Node Buffer's backing slab and ensure alignment
      const arrayBuffer = new ArrayBuffer(chunkSize);
      const uint8View = new Uint8Array(arrayBuffer);
      uint8View.set(chunkBuffer);
      samples = new Int16Array(arrayBuffer);
    }

    offset += 8 + chunkSize;
    // Chunk size odd padding
    if (chunkSize % 2 !== 0) {
      offset += 1;
    }
  }

  if (!fmtFound || !dataFound) {
    throw new Error("VOICE_LIVEKIT_PUBLISH_FAILED: Missing fmt or data chunk");
  }

  if (sampleRate !== audio.sampleRateHertz) {
    throw new Error(`VOICE_LIVEKIT_PUBLISH_FAILED: Sample rate mismatch. Expected ${audio.sampleRateHertz}, got ${sampleRate}`);
  }

  return {
    samples,
    sampleRate,
    channels
  };
}
