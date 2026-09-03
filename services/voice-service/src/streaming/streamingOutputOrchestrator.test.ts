import assert from 'node:assert/strict';
import test from 'node:test';
import type { MeetingAiStreamEvent } from '@ott/shared';
import type { StreamingMeetingAudioSession, StreamingPublishSummary } from '../livekit/StreamingMeetingAudioPublisher.js';
import type { StreamingPcmChunk, StreamingTtsSession } from './googleStreamingTts.js';
import { StreamingOutputError, StreamingOutputOrchestrator } from './streamingOutputOrchestrator.js';

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;
  public push(value: T): void { if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve({ value, done: false }); } else this.values.push(value); }
  public close(): void { this.done = true; this.waiter?.({ value: undefined, done: true }); this.waiter = null; }
  public async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const value = this.values.shift();
      if (value !== undefined) { yield value; continue; }
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => { this.waiter = resolve; });
      if (next.done) return;
      yield next.value;
    }
  }
}

test('publishes the first audio before AI done and excludes display/source from TTS', async () => {
  const audioQueue = new AsyncQueue<StreamingPcmChunk>();
  const ttsText: string[] = [];
  const tts: StreamingTtsSession = {
    audio: audioQueue,
    writeSegment: async (_sequence, text) => {
      ttsText.push(text);
      const audio = Buffer.alloc(960);
      audioQueue.push({ segmentSequence: ttsText.length - 1, audio, encoding: 'PCM16LE', sampleRateHertz: 24_000, channelCount: 1, receivedAtMs: 1 });
    },
    finish: async () => audioQueue.close(),
    cancel: async () => audioQueue.close(),
    getSegmentLedger: () => [],
  };
  let markFirstFrame!: () => void;
  const firstFrame = new Promise<void>((resolve) => { markFirstFrame = resolve; });
  const writtenAudio: StreamingPcmChunk[] = [];
  const summary: StreamingPublishSummary = {
    meetingSessionId: 'm1', roomName: 'r1', turnId: 't1', identity: 'm1-bot', firstFrameAtMs: 1, playoutCompletedAtMs: 2,
    resampler: { inputSamples: 1, outputSamples: 2, inputSampleRateHertz: 24_000 },
    frames: { frameCount: 1, sourceSamples: 2, paddedSamples: 958 },
  };
  const publisher = {
    start: async (input: { onFirstFrame?: () => void }): Promise<StreamingMeetingAudioSession> => ({
      write: async (chunk) => { writtenAudio.push(chunk); input.onFirstFrame?.(); markFirstFrame(); },
      finish: async () => summary,
      cancel: async () => undefined,
    }),
  };
  const sideChannel: string[] = [];
  async function* events(): AsyncGenerator<MeetingAiStreamEvent> {
    yield { type: 'speech.delta', version: 1, turnId: 't1', sequence: 0, text: 'Cau tra loi dau tien.' };
    await firstFrame;
    yield { type: 'display.delta', version: 1, turnId: 't1', sequence: 0, text: '**display**' };
    yield { type: 'source', version: 1, turnId: 't1', sequence: 0, documentId: 'doc', title: 'title', chunkId: 'chunk' };
    yield { type: 'done', version: 1, turnId: 't1', replayed: false };
  }
  const orchestrator = new StreamingOutputOrchestrator({ open: () => tts }, publisher, {
    minimumChars: 8, targetChars: 80, maximumChars: 120, maximumBytes: 1_000, flushTimeoutMs: 500,
  });
  const result = await orchestrator.run({
    meetingSessionId: 'm1', roomName: 'r1', turnId: 't1', events: events(),
    onSideChannelEvent: (event) => { sideChannel.push(event.type); },
  });
  assert.deepEqual(ttsText, ['Cau tra loi dau tien.']);
  assert.equal(writtenAudio.length, 1);
  assert.deepEqual(sideChannel, ['display.delta', 'source']);
  assert.equal(result.speechDeltaCount, 1);
  assert.equal(result.audioChunkCount, 1);
  assert.equal(result.audio, summary);
  assert.ok(result.startedAtMonotonicMs > 0);
  assert.ok(result.firstAudioAtMonotonicMs !== null);
  assert.ok(result.firstFrameAtMonotonicMs !== null);
  assert.ok(result.aiDoneAtMonotonicMs >= result.startedAtMonotonicMs);
  assert.ok(result.ttsDoneAtMonotonicMs >= result.aiDoneAtMonotonicMs);
  assert.ok(result.playoutCompletedAtMonotonicMs >= result.ttsDoneAtMonotonicMs);
});

test('keeps consuming AI until done when TTS fails before first frame and exposes safe fallback text', async () => {
  const audioQueue = new AsyncQueue<StreamingPcmChunk>();
  const tts: StreamingTtsSession = {
    audio: audioQueue,
    writeSegment: async () => { throw new Error('provider failed'); },
    finish: async () => audioQueue.close(),
    cancel: async () => audioQueue.close(),
    getSegmentLedger: () => [],
  };
  let cancelled = 0;
  let meetingClosed = 0;
  const publisher = {
    start: async (): Promise<StreamingMeetingAudioSession> => ({
      write: async () => undefined,
      finish: async () => { throw new Error('must not finish'); },
      cancel: async () => { cancelled += 1; },
    }),
    closeMeeting: async () => { meetingClosed += 1; },
  };
  let doneConsumed = false;
  async function* events(): AsyncGenerator<MeetingAiStreamEvent> {
    yield { type: 'speech.delta', version: 1, turnId: 't1', sequence: 0, text: 'Câu hoàn chỉnh.' };
    yield { type: 'display.delta', version: 1, turnId: 't1', sequence: 0, text: 'Câu hoàn chỉnh.' };
    doneConsumed = true;
    yield { type: 'done', version: 1, turnId: 't1', replayed: false };
  }
  const orchestrator = new StreamingOutputOrchestrator({ open: () => tts }, publisher, {
    minimumChars: 1, targetChars: 80, maximumChars: 120, maximumBytes: 1_000, flushTimeoutMs: 500,
  });
  await assert.rejects(
    orchestrator.run({ meetingSessionId: 'm1', roomName: 'r1', turnId: 't1', events: events() }),
    (error) => error instanceof StreamingOutputError
      && error.aiDone
      && !error.firstFramePublished
      && error.fallbackSpeechText === 'Câu hoàn chỉnh.',
  );
  assert.equal(doneConsumed, true);
  assert.ok(cancelled >= 1);
  assert.ok(meetingClosed >= 1);
});

test('rejects an apparently successful playout when no audio frame was published', async () => {
  const audioQueue = new AsyncQueue<StreamingPcmChunk>();
  const tts: StreamingTtsSession = {
    audio: audioQueue,
    writeSegment: async () => undefined,
    finish: async () => audioQueue.close(),
    cancel: async () => audioQueue.close(),
    getSegmentLedger: () => [],
  };
  let meetingClosed = 0;
  const publisher = {
    start: async (): Promise<StreamingMeetingAudioSession> => ({
      write: async () => undefined,
      finish: async () => ({
        meetingSessionId: 'm1', roomName: 'r1', turnId: 't1', identity: 'm1-bot',
        firstFrameAtMs: null, playoutCompletedAtMs: 2,
        resampler: { inputSamples: 0, outputSamples: 0, inputSampleRateHertz: 24_000 },
        frames: { frameCount: 0, sourceSamples: 0, paddedSamples: 0 },
      }),
      cancel: async () => undefined,
    }),
    closeMeeting: async () => { meetingClosed += 1; },
  };
  async function* events(): AsyncGenerator<MeetingAiStreamEvent> {
    yield { type: 'speech.delta', version: 1, turnId: 't1', sequence: 0, text: 'Không có audio.' };
    yield { type: 'done', version: 1, turnId: 't1', replayed: false };
  }
  const orchestrator = new StreamingOutputOrchestrator({ open: () => tts }, publisher, {
    minimumChars: 1, targetChars: 80, maximumChars: 120, maximumBytes: 1_000, flushTimeoutMs: 500,
  });

  await assert.rejects(
    orchestrator.run({ meetingSessionId: 'm1', roomName: 'r1', turnId: 't1', events: events() }),
    (error) => error instanceof StreamingOutputError
      && error.aiDone
      && !error.firstFramePublished
      && error.fallbackSpeechText === 'Không có audio.',
  );
  assert.ok(meetingClosed >= 1);
});
