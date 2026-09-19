import assert from 'node:assert/strict';
import test from 'node:test';
import type { SttProviderBundle, TtsProviderBundle } from './contracts.js';
import { createSelectedVoiceProviders } from './providerFactory.js';

function stt(name: string): SttProviderBundle {
  return {
    batch: { transcribe: async () => ({ transcript: name, confidence: null }) },
    streaming: { open: () => ({ write: async () => undefined, finish: async () => undefined, cancel: () => undefined }) },
  };
}

function tts(name: string): TtsProviderBundle {
  return {
    batch: {
      synthesize: async () => ({
        audio: Buffer.from(name),
        contentType: 'audio/wav',
        encoding: 'LINEAR16',
        sampleRateHertz: 24_000,
        channelCount: 1,
      }),
    },
    streaming: {
      open: () => ({
        writeSegment: async () => undefined,
        finish: async () => undefined,
        cancel: async () => undefined,
        audio: { async *[Symbol.asyncIterator]() {} },
        getSegmentLedger: () => [],
      }),
    },
  };
}

test('creates only the independently selected STT and TTS providers', async () => {
  const calls: string[] = [];
  const selected = createSelectedVoiceProviders(
    { sttProvider: 'elevenlabs', ttsProvider: 'google' },
    {
      google: {
        createStt: () => { calls.push('google-stt'); return stt('google'); },
        createTts: () => { calls.push('google-tts'); return tts('google'); },
      },
      elevenlabs: {
        createStt: () => { calls.push('elevenlabs-stt'); return stt('elevenlabs'); },
        createTts: () => { calls.push('elevenlabs-tts'); return tts('elevenlabs'); },
      },
    },
  );

  assert.deepEqual(calls, ['elevenlabs-stt', 'google-tts']);
  assert.equal((await selected.stt.batch.transcribe(Buffer.alloc(2), 'audio/pcm')).transcript, 'elevenlabs');
  assert.equal((await selected.tts.batch.synthesize('hello')).audio.toString(), 'google');
});

test('fails clearly when a selected provider capability is not registered', () => {
  assert.throws(
    () => createSelectedVoiceProviders(
      { sttProvider: 'elevenlabs', ttsProvider: 'google' },
      { google: { createStt: () => stt('google'), createTts: () => tts('google') } },
    ),
    /STT provider elevenlabs is not registered/,
  );
  assert.throws(
    () => createSelectedVoiceProviders(
      { sttProvider: 'google', ttsProvider: 'elevenlabs' },
      {
        google: { createStt: () => stt('google'), createTts: () => tts('google') },
        elevenlabs: { createStt: () => stt('elevenlabs') },
      },
    ),
    /TTS provider elevenlabs does not implement TTS/,
  );
});
