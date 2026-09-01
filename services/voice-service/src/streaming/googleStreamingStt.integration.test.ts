import assert from 'node:assert/strict';
import test from 'node:test';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { loadVoiceServiceConfig } from '../config.js';
import { GoogleStreamingSttAdapter, StreamingSttError, type StreamingSttResult } from './googleStreamingStt.js';

const enabled = process.env.VOICE_PROVIDER_INTEGRATION === '1';

function wavPcmData(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') sampleRate = wav.readUInt32LE(offset + 12);
    if (id === 'data') return { pcm: wav.subarray(offset + 8, offset + 8 + size), sampleRate };
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV data chunk is missing');
}

test('streams synthetic Vietnamese PCM through Google Speech V2 Chirp 3', {
  skip: enabled ? false : 'VOICE_PROVIDER_INTEGRATION is not enabled',
  timeout: 90_000,
}, async (context) => {
  const config = loadVoiceServiceConfig();
  assert.ok(config.googleCloudProject, 'GOOGLE_CLOUD_PROJECT is required');
  const tts = new TextToSpeechClient({ projectId: config.googleCloudProject });
  const [response] = await tts.synthesizeSpeech({
    input: { text: 'Xin chào, đây là kiểm thử truyền âm thanh trực tiếp.' },
    voice: { name: config.googleTtsVoice, languageCode: 'vi-VN' },
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 16_000 },
  });
  const audio = Buffer.from(response.audioContent as Uint8Array);
  const { pcm, sampleRate } = wavPcmData(audio);
  assert.equal(sampleRate, 16_000);

  const results: StreamingSttResult[] = [];
  const adapter = new GoogleStreamingSttAdapter({
    projectId: config.googleCloudProject,
    location: config.googleStreamingSttLocation,
    model: config.googleStreamingSttModel,
    languageCode: 'vi-VN',
    timeoutMs: config.streamingSttTimeoutMs,
  });
  const startedAt = performance.now();
  const session = adapter.open({ onResult: (result) => results.push(result) });
  try {
    for (let offset = 0; offset < pcm.length; offset += 640) {
      const source = pcm.subarray(offset, Math.min(offset + 640, pcm.length));
      const chunk = source.length === 640 ? source : Buffer.concat([source, Buffer.alloc(640 - source.length)]);
      await session.write(chunk);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await session.finish();
  } catch (error) {
    if (error instanceof StreamingSttError) context.diagnostic(JSON.stringify({
      code: error.code,
      providerCode: error.providerCode,
      providerMessage: error.providerMessage,
    }));
    throw error;
  }
  const finalText = results.filter(({ isFinal }) => isFinal).map(({ text }) => text).join(' ').trim();
  assert.ok(finalText.length > 0);
  context.diagnostic(JSON.stringify({
    audioBytes: pcm.length,
    partialResults: results.filter(({ isFinal }) => !isFinal).length,
    finalResults: results.filter(({ isFinal }) => isFinal).length,
    finalCharacters: finalText.length,
    durationMs: Math.round(performance.now() - startedAt),
  }));
  await tts.close();
});
