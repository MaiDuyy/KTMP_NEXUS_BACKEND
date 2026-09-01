import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { CancellableStream } from 'google-gax';
import { GoogleStreamingTtsAdapter, StreamingTtsError } from './googleStreamingTts.js';

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

class NeverEndingStream extends FakeStream {
  public override end(): void {}
}

function createAdapter(stream: FakeStream, maximumQueuedBytes = 256): GoogleStreamingTtsAdapter {
  return new GoogleStreamingTtsAdapter({
    projectId: 'project-1',
    location: 'asia-southeast1',
    voiceName: 'vi-VN-Chirp3-HD-Charon',
    sampleRateHertz: 24_000,
    firstAudioTimeoutMs: 1_000,
    idleAudioTimeoutMs: 1_000,
    totalTimeoutMs: 2_000,
    maximumQueuedBytes,
  }, { streamingSynthesize: () => stream as unknown as CancellableStream });
}

test('writes Google streaming config before ordered text inputs and emits PCM chunks', async () => {
  const stream = new FakeStream();
  const session = createAdapter(stream).open();
  const config = stream.writes[0] as any;
  assert.deepEqual(config, {
    streamingConfig: {
      voice: { languageCode: 'vi-VN', name: 'vi-VN-Chirp3-HD-Charon' },
      streamingAudioConfig: { audioEncoding: 'PCM', sampleRateHertz: 24_000 },
    },
  });

  await session.writeSegment(0, 'Xin chao');
  await session.writeSegment(1, 'Nexus');
  assert.deepEqual(stream.writes.slice(1), [{ input: { text: 'Xin chao' } }, { input: { text: 'Nexus' } }]);
  stream.emit('data', { audioContent: Buffer.from([1, 2, 3, 4]) });
  const iterator = session.audio[Symbol.asyncIterator]();
  const item = await iterator.next();
  assert.equal(item.value?.segmentSequence, 0);
  assert.deepEqual(item.value?.audio, Buffer.from([1, 2, 3, 4]));
  assert.equal(item.value?.sampleRateHertz, 24_000);
  assert.equal(item.value?.channelCount, 1);
  assert.equal(item.value?.encoding, 'PCM16LE');
  assert.ok((item.value?.receivedAtMs ?? 0) > 0);
  await session.finish();
  assert.deepEqual(session.getSegmentLedger(), [
    { segmentSequence: 0, state: 'AUDIO_COMPLETED' },
    { segmentSequence: 1, state: 'AUDIO_COMPLETED' },
  ]);
});

test('applies stream backpressure and rejects invalid ordered input', async () => {
  const stream = new FakeStream();
  stream.backpressure = true;
  const session = createAdapter(stream).open();
  const writing = session.writeSegment(0, 'Xin chao');
  queueMicrotask(() => stream.emit('drain'));
  await writing;
  await assert.rejects(
    session.writeSegment(0, 'trung lap'),
    (error: unknown) => error instanceof StreamingTtsError && error.code === 'VOICE_TTS_UNAVAILABLE',
  );
  await session.cancel();
  assert.deepEqual(session.getSegmentLedger(), [{ segmentSequence: 0, state: 'CANCELLED' }]);
});

test('waits for a terminal provider event and fails a finished stream that never produces audio', async () => {
  const stream = new NeverEndingStream();
  const adapter = new GoogleStreamingTtsAdapter({
    projectId: 'project-1',
    location: 'asia-southeast1',
    voiceName: 'vi-VN-Chirp3-HD-Charon',
    sampleRateHertz: 24_000,
    firstAudioTimeoutMs: 20,
    idleAudioTimeoutMs: 20,
    totalTimeoutMs: 100,
    maximumQueuedBytes: 256,
  }, { streamingSynthesize: () => stream as unknown as CancellableStream });
  const session = adapter.open();
  await session.writeSegment(0, 'Xin chao');
  await assert.rejects(
    session.finish(),
    (error: unknown) => error instanceof StreamingTtsError && error.code === 'VOICE_TTS_TIMEOUT',
  );
  assert.equal(stream.cancelled, true);
});

test('does not allow a provider stream to finish without a submitted segment', async () => {
  const stream = new FakeStream();
  const session = createAdapter(stream).open();
  await assert.rejects(
    session.finish(),
    (error: unknown) => error instanceof StreamingTtsError && error.code === 'VOICE_NO_SPEECH',
  );
  assert.equal(stream.cancelled, true);
});

test('fails the consumer and cancels the provider when the bounded queue overflows', async () => {
  const stream = new FakeStream();
  const session = createAdapter(stream, 3).open();
  stream.emit('data', { audioContent: Buffer.from([1, 2, 3, 4]) });
  assert.equal(stream.cancelled, true);
  await assert.rejects(
    session.audio[Symbol.asyncIterator]().next(),
    (error: unknown) => error instanceof StreamingTtsError && error.code === 'VOICE_TTS_UNAVAILABLE',
  );
});

test('maps caller cancellation and provider deadlines to stable errors', async () => {
  const controller = new AbortController();
  const stream = new FakeStream();
  const session = createAdapter(stream).open(controller.signal);
  controller.abort();
  assert.equal(stream.cancelled, true);
  await assert.rejects(
    session.audio[Symbol.asyncIterator]().next(),
    (error: unknown) => error instanceof StreamingTtsError && error.code === 'VOICE_CANCELLED',
  );

  const deadlineStream = new FakeStream();
  const deadlineSession = createAdapter(deadlineStream).open();
  deadlineStream.emit('error', { code: 'DEADLINE_EXCEEDED', message: 'deadline' });
  await assert.rejects(
    deadlineSession.audio[Symbol.asyncIterator]().next(),
    (error: unknown) => error instanceof StreamingTtsError && error.code === 'VOICE_TTS_TIMEOUT',
  );
});
