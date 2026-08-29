import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleBatchSttAdapter } from './batchStt.js';
import { GoogleBatchTtsAdapter } from './batchTts.js';
import { loadVoiceServiceConfig } from './config.js';

const enabled = process.env.VOICE_PROVIDER_INTEGRATION === '1';

test('round-trips synthetic Vietnamese speech through Google TTS and STT', {
  skip: enabled ? false : 'VOICE_PROVIDER_INTEGRATION is not enabled',
  timeout: 60_000,
}, async (context) => {
  const config = loadVoiceServiceConfig();
  assert.ok(config.googleCloudProject, 'GOOGLE_CLOUD_PROJECT is required');
  const tts = new GoogleBatchTtsAdapter({
    projectId: config.googleCloudProject,
    location: config.googleCloudLocation,
    voiceName: config.googleTtsVoice,
    audioEncoding: config.googleTtsAudioEncoding,
    timeoutMs: config.googleTtsTimeoutMs,
  });
  const stt = new GoogleBatchSttAdapter({
    projectId: config.googleCloudProject,
    location: config.googleCloudLocation,
    model: config.googleSttModel,
    languageCode: config.googleSttLanguage,
    timeoutMs: config.sttTimeoutMs,
  });

  const startedAt = performance.now();
  const audio = await tts.synthesize('Xin chào, đây là kiểm thử trợ lý cuộc họp.');
  const ttsLatencyMs = Math.round(performance.now() - startedAt);
  const sttStartedAt = performance.now();
  const result = await stt.transcribe(audio.audio, audio.contentType);
  const sttLatencyMs = Math.round(performance.now() - sttStartedAt);

  assert.ok(audio.audio.length > 44);
  assert.equal(audio.contentType, 'audio/wav');
  assert.ok(result.transcript.trim().length > 0);
  context.diagnostic(JSON.stringify({
    ttsLatencyMs,
    sttLatencyMs,
    audioBytes: audio.audio.length,
    transcriptCharacters: result.transcript.length,
  }));
});
