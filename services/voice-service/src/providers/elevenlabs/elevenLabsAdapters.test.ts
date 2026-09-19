import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { BatchSttError, BatchTtsError, StreamingSttError } from '../contracts.js';
import { ElevenLabsBatchSttAdapter } from './elevenLabsBatchStt.js';
import { ElevenLabsBatchTtsAdapter } from './elevenLabsBatchTts.js';
import { ElevenLabsStreamingSttAdapter } from './elevenLabsStreamingStt.js';
import { ElevenLabsStreamingTtsAdapter } from './elevenLabsStreamingTts.js';

const pcm = Buffer.alloc(3_200, 1);

function batchStt(fetchImpl: typeof fetch): ElevenLabsBatchSttAdapter {
  return new ElevenLabsBatchSttAdapter({
    apiKey: 'test-key',
    apiBaseUrl: 'https://provider.test',
    model: 'scribe_v2',
    languageCode: 'vi',
    timeoutMs: 1_000,
    maximumInputBytes: 10_000,
  }, undefined, fetchImpl);
}

function batchTts(fetchImpl: typeof fetch): ElevenLabsBatchTtsAdapter {
  return new ElevenLabsBatchTtsAdapter({
    apiKey: 'test-key',
    apiBaseUrl: 'https://provider.test',
    voiceId: 'voice-id',
    model: 'eleven_flash_v2_5',
    languageCode: 'vi',
    outputFormat: 'pcm_24000',
    timeoutMs: 1_000,
    maximumOutputBytes: 10_000,
  }, undefined, fetchImpl);
}

test('batch STT sends multipart input once and maps the transcript', async () => {
  let calls = 0;
  const adapter = batchStt(async (input, init) => {
    calls += 1;
    assert.equal(String(input), 'https://provider.test/v1/speech-to-text');
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>)['xi-api-key'], 'test-key');
    const form = init?.body as FormData;
    assert.equal(form.get('model_id'), 'scribe_v2');
    assert.equal(form.get('language_code'), 'vi');
    return Response.json({ text: '  Xin chao Nexus  ' });
  });
  assert.deepEqual(await adapter.transcribe(Buffer.from('audio'), 'audio/webm'), {
    transcript: 'Xin chao Nexus',
    confidence: null,
  });
  assert.equal(calls, 1);
});

test('batch STT maps quota without redispatch', async () => {
  let calls = 0;
  const adapter = batchStt(async () => {
    calls += 1;
    return new Response('{}', { status: 429 });
  });
  await assert.rejects(adapter.transcribe(Buffer.from('audio'), 'audio/webm'), (error: unknown) => {
    assert.equal((error as BatchSttError).code, 'VOICE_STT_QUOTA_EXCEEDED');
    return true;
  });
  assert.equal(calls, 1);
});

test('batch TTS wraps raw PCM in the WAV contract consumed by LiveKit', async () => {
  const adapter = batchTts(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/v1/text-to-speech/voice-id/stream');
    assert.equal(url.searchParams.get('output_format'), 'pcm_24000');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      text: 'Xin chao',
      model_id: 'eleven_flash_v2_5',
      language_code: 'vi',
    });
    return new Response(Buffer.alloc(960, 2), { status: 200 });
  });
  const result = await adapter.synthesize('Xin chao');
  assert.equal(result.audio.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(result.audio.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(result.audio.length, 1_004);
  assert.equal(result.sampleRateHertz, 24_000);
  assert.equal(result.channelCount, 1);
});

test('batch TTS rejects malformed PCM and empty text', async () => {
  const adapter = batchTts(async () => new Response(Buffer.from([1]), { status: 200 }));
  await assert.rejects(adapter.synthesize('noi'), (error: unknown) => {
    assert.equal((error as BatchTtsError).code, 'VOICE_TTS_UNAVAILABLE');
    return true;
  });
  await assert.rejects(adapter.synthesize('   '), (error: unknown) => {
    assert.equal((error as BatchTtsError).code, 'VOICE_NO_SPEECH');
    return true;
  });
});

async function localServer(
  onConnection: (socket: WebSocket, requestUrl: string, apiKey: string | undefined) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new WebSocketServer({ port: 0 });
  server.on('connection', (socket, request) => {
    onConnection(socket, request.url ?? '', request.headers['xi-api-key'] as string | undefined);
  });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('Missing test server address');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, 'close');
    },
  };
}

test('streaming STT preserves partial/final ordering and commits exactly once', async () => {
  const frames: Array<Record<string, unknown>> = [];
  let observedUrl = '';
  let observedKey: string | undefined;
  const server = await localServer((socket, requestUrl, apiKey) => {
    observedUrl = requestUrl;
    observedKey = apiKey;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.commit === false) {
        socket.send(JSON.stringify({ message_type: 'partial_transcript', text: 'xin' }));
      } else {
        socket.send(JSON.stringify({ message_type: 'committed_transcript', text: 'xin chao' }));
      }
    });
  });
  try {
    const results: Array<{ text: string; isFinal: boolean }> = [];
    const adapter = new ElevenLabsStreamingSttAdapter({
      apiKey: 'test-key', endpoint: server.url, model: 'scribe_v2_realtime', languageCode: 'vi',
      timeoutMs: 2_000, maximumQueuedBytes: 32_000, minimumChunkBytes: 3_200,
    });
    const session = adapter.open({ onResult: (result) => results.push(result) });
    await session.write(pcm);
    await session.finish();
    assert.deepEqual(results.map(({ text, isFinal }) => ({ text, isFinal })), [
      { text: 'xin', isFinal: false },
      { text: 'xin chao', isFinal: true },
    ]);
    assert.equal(frames.filter((frame) => frame.commit === true).length, 1);
    assert.match(observedUrl, /model_id=scribe_v2_realtime/);
    assert.match(observedUrl, /audio_format=pcm_16000/);
    assert.equal(observedKey, 'test-key');
  } finally {
    await server.close();
  }
});

test('streaming STT maps provider quota and cancel remains idempotent', async () => {
  const server = await localServer((socket) => {
    socket.send(JSON.stringify({ message_type: 'quota_exceeded' }));
  });
  try {
    const adapter = new ElevenLabsStreamingSttAdapter({
      apiKey: 'test-key', endpoint: server.url, model: 'scribe_v2_realtime', languageCode: 'vi',
      timeoutMs: 2_000, maximumQueuedBytes: 32_000,
    });
    const session = adapter.open({ onResult: () => undefined });
    await assert.rejects((async () => {
      await session.write(Buffer.alloc(640));
      await session.finish();
    })(), (error: unknown) => {
      assert.equal((error as StreamingSttError).code, 'VOICE_STT_QUOTA_EXCEEDED');
      return true;
    });
    session.cancel();
    session.cancel();
  } finally {
    await server.close();
  }
});

test('streaming TTS emits ordered PCM, flushes and completes ledger', async () => {
  const frames: Array<Record<string, unknown>> = [];
  const server = await localServer((socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (typeof frame.text === 'string' && frame.text.trim().length > 0) {
        socket.send(JSON.stringify({ audio: Buffer.alloc(960, 3).toString('base64'), is_final: false }));
      }
      if (frame.text === '') socket.send(JSON.stringify({ isFinal: true }));
    });
  });
  try {
    const adapter = new ElevenLabsStreamingTtsAdapter({
      apiKey: 'test-key', endpoint: `${server.url}/v1/text-to-speech`, voiceId: 'voice-id',
      model: 'eleven_flash_v2_5', languageCode: 'vi', outputFormat: 'pcm_24000',
      firstAudioTimeoutMs: 1_000, idleAudioTimeoutMs: 1_000, totalTimeoutMs: 2_000,
      maximumQueuedBytes: 32_000,
    });
    const session = adapter.open();
    const received: Buffer[] = [];
    const consume = (async () => {
      for await (const chunk of session.audio) {
        assert.equal(chunk.sampleRateHertz, 24_000);
        received.push(chunk.audio);
      }
    })();
    await session.writeSegment(0, 'Xin chao');
    await session.finish();
    await consume;
    assert.equal(received.length, 1);
    assert.deepEqual(session.getSegmentLedger(), [{ segmentSequence: 0, state: 'AUDIO_COMPLETED' }]);
    assert.equal(frames.filter((frame) => frame.text === '').length, 1);
  } finally {
    await server.close();
  }
});

test('streaming TTS cancel is idempotent and rejects late writes', async () => {
  const server = await localServer(() => undefined);
  try {
    const adapter = new ElevenLabsStreamingTtsAdapter({
      apiKey: 'test-key', endpoint: server.url, voiceId: 'voice-id', model: 'eleven_flash_v2_5',
      languageCode: 'vi', outputFormat: 'pcm_24000', firstAudioTimeoutMs: 1_000,
      idleAudioTimeoutMs: 1_000, totalTimeoutMs: 2_000, maximumQueuedBytes: 32_000,
    });
    const session = adapter.open();
    await session.cancel();
    await session.cancel();
    await assert.rejects(session.writeSegment(0, 'late'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'VOICE_CANCELLED');
      return true;
    });
  } finally {
    await server.close();
  }
});
