import assert from 'node:assert/strict';
import test from 'node:test';
import { ElevenLabsBatchSttAdapter } from './elevenLabsBatchStt.js';
import { ElevenLabsBatchTtsAdapter } from './elevenLabsBatchTts.js';
import { ElevenLabsStreamingSttAdapter } from './elevenLabsStreamingStt.js';
import { ElevenLabsStreamingTtsAdapter } from './elevenLabsStreamingTts.js';

const enabled = process.env.ELEVENLABS_PROVIDER_INTEGRATION === '1';
const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const voiceId = process.env.ELEVENLABS_TTS_VOICE_ID?.trim();
const canRun = enabled && Boolean(apiKey && voiceId);

test('round-trips Vietnamese speech through all four ElevenLabs adapters', {
  skip: canRun ? false : 'ELEVENLABS_PROVIDER_INTEGRATION, API key, and voice ID are required',
  timeout: 90_000,
}, async () => {
  const common = {
    apiKey: apiKey!,
    languageCode: 'vi',
  };
  const batchTts = new ElevenLabsBatchTtsAdapter({
    ...common,
    apiBaseUrl: 'https://api.elevenlabs.io',
    voiceId: voiceId!,
    model: process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_flash_v2_5',
    outputFormat: 'pcm_16000',
    timeoutMs: 30_000,
    maximumOutputBytes: 8 * 1024 * 1024,
  });
  const batchStt = new ElevenLabsBatchSttAdapter({
    ...common,
    apiBaseUrl: 'https://api.elevenlabs.io',
    model: process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v2',
    timeoutMs: 30_000,
    maximumInputBytes: 10 * 1024 * 1024,
  });
  const phrase = 'Cuoc hop hom nay ban ve ke hoach trien khai tro ly giong noi.';
  const wav = await batchTts.synthesize(phrase);
  assert.ok(wav.audio.length > 44);
  const batchTranscript = await batchStt.transcribe(wav.audio, 'audio/wav');
  assert.ok(batchTranscript.transcript.length > 0);

  const streamingTts = new ElevenLabsStreamingTtsAdapter({
    ...common,
    endpoint: 'wss://api.elevenlabs.io/v1/text-to-speech',
    voiceId: voiceId!,
    model: process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_flash_v2_5',
    outputFormat: 'pcm_16000',
    firstAudioTimeoutMs: 15_000,
    idleAudioTimeoutMs: 15_000,
    totalTimeoutMs: 60_000,
    maximumQueuedBytes: 2 * 1024 * 1024,
  });
  const ttsSession = streamingTts.open();
  const chunks: Buffer[] = [];
  const consume = (async () => {
    for await (const chunk of ttsSession.audio) chunks.push(chunk.audio);
  })();
  await ttsSession.writeSegment(0, phrase);
  await ttsSession.finish();
  await consume;
  const rawPcm = Buffer.concat(chunks);
  assert.ok(rawPcm.length > 0);

  const finalTranscripts: string[] = [];
  const streamingStt = new ElevenLabsStreamingSttAdapter({
    ...common,
    endpoint: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
    model: process.env.ELEVENLABS_STREAMING_STT_MODEL ?? 'scribe_v2_realtime',
    timeoutMs: 60_000,
    maximumQueuedBytes: 512 * 1024,
  });
  const sttSession = streamingStt.open({
    onResult: (result) => {
      if (result.isFinal && result.text) finalTranscripts.push(result.text);
    },
  });
  for (let offset = 0; offset < rawPcm.length; offset += 3_200) {
    let chunk = rawPcm.subarray(offset, Math.min(offset + 3_200, rawPcm.length));
    if (chunk.length % 2 !== 0) chunk = chunk.subarray(0, chunk.length - 1);
    if (chunk.length > 0) await sttSession.write(chunk);
  }
  await sttSession.finish();
  assert.ok(finalTranscripts.join(' ').length > 0);
});
