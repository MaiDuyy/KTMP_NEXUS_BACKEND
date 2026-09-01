import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleStreamingTtsAdapter, type StreamingPcmChunk } from './googleStreamingTts.js';

const runProviderIntegration = process.env.VOICE_PROVIDER_INTEGRATION === 'true';

test('streams Vietnamese PCM from Google Cloud TTS', { skip: runProviderIntegration ? undefined : 'VOICE_PROVIDER_INTEGRATION is not enabled' }, async () => {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  assert.ok(projectId, 'GOOGLE_CLOUD_PROJECT is required');
  const adapter = new GoogleStreamingTtsAdapter({
    projectId,
    location: process.env.GOOGLE_STREAMING_TTS_LOCATION ?? 'asia-southeast1',
    voiceName: process.env.GOOGLE_STREAMING_TTS_VOICE ?? process.env.GOOGLE_TTS_VOICE ?? 'vi-VN-Chirp3-HD-Charon',
    sampleRateHertz: 24_000,
    firstAudioTimeoutMs: 10_000,
    idleAudioTimeoutMs: 15_000,
    totalTimeoutMs: 60_000,
    maximumQueuedBytes: 512 * 1024,
  });
  const session = adapter.open();
  const chunks: StreamingPcmChunk[] = [];
  let markFirstAudio!: () => void;
  const firstAudio = new Promise<void>((resolve) => { markFirstAudio = resolve; });
  const consume = (async () => {
    for await (const chunk of session.audio) {
      chunks.push(chunk);
      markFirstAudio();
    }
  })();
  await session.writeSegment(0, 'Xin chao.');
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timeoutHandle = setTimeout(() => rejectTimeout(new Error('first audio timeout')), 10_500);
  try {
    await Promise.race([firstAudio, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  await session.writeSegment(1, 'Day la kiem thu am thanh truc tuyen.');
  await session.finish();
  await consume;

  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((chunk) => chunk.audio.length > 0 && chunk.sampleRateHertz === 24_000));
});
