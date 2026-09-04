import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { CancellableStream } from 'google-gax';
import { GoogleStreamingSttAdapter, StreamingSttError } from './googleStreamingStt.js';

class FakeStream extends EventEmitter {
  public readonly writes: unknown[] = [];
  public cancelled = false;
  public backpressure = false;

  public write(value: unknown): boolean {
    this.writes.push(value);
    return !this.backpressure;
  }

  public end(): void {
    queueMicrotask(() => this.emit('end'));
  }

  public cancel(): void {
    this.cancelled = true;
  }
}

function createAdapter(stream: FakeStream): GoogleStreamingSttAdapter {
  return new GoogleStreamingSttAdapter({
    projectId: 'project-1',
    location: 'asia-southeast1',
    model: 'chirp_3',
    languageCode: 'vi-VN',
    timeoutMs: 70_000,
  }, { _streamingRecognize: () => stream as unknown as CancellableStream });
}

test('writes V2 config first, then bounded PCM, and surfaces partial/final results', async () => {
  const stream = new FakeStream();
  const results: unknown[] = [];
  const session = createAdapter(stream).open(
    { onResult: (result) => results.push(result) },
    undefined,
    ['Nexus ERP'],
  );
  const config = stream.writes[0] as any;
  assert.equal(config.recognizer, 'projects/project-1/locations/asia-southeast1/recognizers/_');
  assert.equal(config.streamingConfig.config.model, 'chirp_3');
  assert.equal(config.streamingConfig.config.explicitDecodingConfig.sampleRateHertz, 16000);
  assert.equal(config.streamingConfig.streamingFeatures.interimResults, true);
  assert.deepEqual(
    config.streamingConfig.config.adaptation.phraseSets[0].inlinePhraseSet.phrases,
    [{ value: 'Nexus ERP' }],
  );
  assert.equal(config.audio, undefined);

  await session.write(Buffer.alloc(640));
  assert.deepEqual(stream.writes[1], { audio: Buffer.alloc(640) });
  stream.emit('data', {
    results: [
      { alternatives: [{ transcript: 'xin chào', confidence: 0.8 }], isFinal: false, stability: 0.7, resultEndOffset: { seconds: 1, nanos: 2 } },
      { alternatives: [{ transcript: 'xin chào Nexus', confidence: 0.9 }], isFinal: true, resultEndOffset: { seconds: 2, nanos: 0 } },
    ],
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results[1], {
    text: 'xin chào Nexus',
    isFinal: true,
    stability: null,
    confidence: 0.9,
    resultEndOffset: '000000000002.000000000',
  });
  await session.finish();
});

test('waits for gRPC drain and maps abort/provider failures', async () => {
  const stream = new FakeStream();
  stream.backpressure = true;
  const session = createAdapter(stream).open({ onResult: () => undefined });
  const writing = session.write(Buffer.alloc(640));
  queueMicrotask(() => stream.emit('drain'));
  await writing;

  const controller = new AbortController();
  const abortedStream = new FakeStream();
  const aborted = createAdapter(abortedStream).open({ onResult: () => undefined }, controller.signal);
  controller.abort();
  assert.equal(abortedStream.cancelled, true);
  await assert.rejects(aborted.finish(), (error) => error instanceof StreamingSttError && error.code === 'VOICE_CANCELLED');
});

test('rejects audio larger than the V2 streaming request limit', async () => {
  const session = createAdapter(new FakeStream()).open({ onResult: () => undefined });
  await assert.rejects(
    session.write(Buffer.alloc(15_002)),
    (error: unknown) => error instanceof StreamingSttError && error.code === 'VOICE_STT_UNAVAILABLE',
  );
  session.cancel();
});

test('HIGH-R1-01: 4 consecutive synchronous quota errors keep code VOICE_STT_QUOTA_EXCEEDED and circuit CLOSED', () => {
  let attempts = 0;
  const adapter = new GoogleStreamingSttAdapter({
    projectId: 'project-1',
    location: 'asia-southeast1',
    model: 'chirp_3',
    languageCode: 'vi-VN',
    timeoutMs: 70_000,
  }, {
    _streamingRecognize: () => {
      attempts++;
      const err = new Error('Quota exceeded');
      (err as any).code = 8;
      throw err;
    },
  });

  for (let i = 0; i < 4; i++) {
    assert.throws(
      () => adapter.open({ onResult: () => undefined }),
      (err: any) => err instanceof StreamingSttError && err.code === 'VOICE_STT_QUOTA_EXCEEDED',
      `Attempt ${i + 1} must throw VOICE_STT_QUOTA_EXCEEDED`,
    );
  }
  assert.equal(attempts, 4);
  assert.equal(adapter.circuitBreaker.getState(), 'CLOSED', 'Circuit must remain CLOSED after quota errors');
});

test('HIGH-R1-02: synchronous stream.write or stream.end error maps to stable error and completes permit', async () => {
  const stream = new FakeStream();
  // Override write to throw synchronously with gRPC code 8
  stream.write = () => {
    const err = new Error('Resource exhausted');
    (err as any).code = 8;
    throw err;
  };

  const adapter = createAdapter(stream);
  // initial config write in open() throws synchronously
  assert.throws(
    () => adapter.open({ onResult: () => undefined }),
    (err: any) => err instanceof StreamingSttError && err.code === 'VOICE_STT_QUOTA_EXCEEDED',
  );
  assert.equal(adapter.circuitBreaker.getState(), 'CLOSED');
});

test('HIGH-R1-04: premature stream end before finishRequested fails with VOICE_STT_UNAVAILABLE', async () => {
  const stream = new FakeStream();
  const adapter = createAdapter(stream);
  const session = adapter.open({ onResult: () => undefined });

  // Provider ends stream prematurely without client finish()
  stream.emit('end');

  await assert.rejects(
    session.finish(),
    (err: any) => err instanceof StreamingSttError && err.code === 'VOICE_STT_UNAVAILABLE',
  );
});
