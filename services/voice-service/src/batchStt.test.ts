import assert from 'node:assert/strict';
import test from 'node:test';
import { BatchSttError, GoogleBatchSttAdapter } from './batchStt.js';

const config = {
  projectId: 'project',
  location: 'asia-southeast1',
  model: 'chirp_2',
  languageCode: 'vi-VN',
  timeoutMs: 10_000,
};

test('returns final transcript, confidence and sends raw protobuf bytes', async () => {
  const audio = Buffer.from([1, 2, 3]);
  let request: any;
  const client = {
    recognize: async (value: unknown) => {
      request = value;
      return [{ results: [{ alternatives: [{ transcript: 'xin chao', confidence: 0.9 }] }] }] as [any];
    },
  };
  const adapter = new GoogleBatchSttAdapter(config, client);

  assert.deepEqual(await adapter.transcribe(audio, 'audio/webm'), {
    transcript: 'xin chao',
    confidence: 0.9,
  });
  assert.equal(request.content, audio);
  assert.equal(Buffer.isBuffer(request.content), true);
});

test('maps empty and timeout results', async () => {
  const empty = new GoogleBatchSttAdapter(config, {
    recognize: async () => [{ results: [] }] as [any],
  });
  await assert.rejects(
    () => empty.transcribe(Buffer.from([1]), 'audio/webm'),
    (error: unknown) => error instanceof BatchSttError && error.code === 'VOICE_NO_SPEECH',
  );
  const timeout = new GoogleBatchSttAdapter(config, {
    recognize: async () => { throw { code: 4 }; },
  });
  await assert.rejects(
    () => timeout.transcribe(Buffer.from([1]), 'audio/webm'),
    (error: unknown) => error instanceof BatchSttError && error.code === 'VOICE_STT_TIMEOUT',
  );
});

test('aborts the caller immediately and ignores a late provider result', async () => {
  let resolveProvider!: (value: [any]) => void;
  const provider = new Promise<[any]>((resolve) => { resolveProvider = resolve; });
  const adapter = new GoogleBatchSttAdapter(config, { recognize: async () => provider });
  const controller = new AbortController();
  const result = adapter.transcribe(Buffer.from([1]), 'audio/webm', controller.signal);
  controller.abort();
  await assert.rejects(
    result,
    (error: unknown) => error instanceof BatchSttError && error.code === 'VOICE_CANCELLED',
  );
  resolveProvider([{ results: [{ alternatives: [{ transcript: 'late' }] }] }]);
});
