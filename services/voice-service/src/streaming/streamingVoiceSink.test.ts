import assert from 'node:assert/strict';
import test from 'node:test';
import type { VoicePipelineEvent } from '@ott/shared';
import type { VerifiedVoiceTurnToken } from '../turnTokenVerifier.js';
import { StreamingSttError, type GoogleStreamingSttAdapter, type StreamingSttCallbacks } from './googleStreamingStt.js';
import { StreamingVoiceSinkFactory } from './streamingVoiceSink.js';

const token: VerifiedVoiceTurnToken = {
  userId: 'user-1',
  jti: 'jti-1',
  meetingSessionId: 'meeting-1',
  turnId: 'turn-1',
  chatId: 'chat-1',
  issuedAtSeconds: 1,
  expiresAtSeconds: 2,
};

function harness() {
  let callbacks!: StreamingSttCallbacks;
  let finish: () => Promise<void> = async () => undefined;
  const events: VoicePipelineEvent[] = [];
  const inputs: unknown[] = [];
  let providerCancellations = 0;
  const stt = {
    open: (value: StreamingSttCallbacks) => {
      callbacks = value;
      return {
        write: async () => undefined,
        finish: () => finish(),
        cancel: () => { providerCancellations += 1; },
      };
    },
  } as unknown as GoogleStreamingSttAdapter;
  const factory = new StreamingVoiceSinkFactory({
    stt,
    control: {
      getContext: async () => ({
        meetingSessionId: 'meeting-1', turnId: 'turn-1', ownerUserId: 'user-1', ownerName: 'User One',
        roomName: 'room-1', chatId: 'chat-1', workspaceId: 'workspace-1', participantIds: ['user-1'],
      }),
      emit: async (event) => { events.push(event); },
    },
    pipeline: {
      enqueueTranscript: (input) => { inputs.push(input); return true; },
    },
  });
  return {
    factory,
    events,
    inputs,
    get callbacks() { return callbacks; },
    get providerCancellations() { return providerCancellations; },
    setFinish(value: () => Promise<void>) { finish = value; },
  };
}

test('fans out revisions, deduplicates final offsets and enqueues one ordered transcript', async () => {
  const testHarness = harness();
  const sink = await testHarness.factory.open(token, new AbortController().signal);
  testHarness.callbacks.onResult({ text: 'xin', isFinal: false, stability: 0.5, confidence: null, resultEndOffset: '0001' });
  testHarness.callbacks.onResult({ text: 'phần hai', isFinal: true, stability: null, confidence: 0.8, resultEndOffset: '0002' });
  testHarness.callbacks.onResult({ text: 'phần một', isFinal: true, stability: null, confidence: 1, resultEndOffset: '0001' });
  testHarness.callbacks.onResult({ text: 'phần hai đã sửa', isFinal: true, stability: null, confidence: 0.6, resultEndOffset: '0002' });
  await sink.end(3);

  assert.deepEqual(testHarness.events.map((event) => event.kind), [
    'transcript_partial', 'transcript_partial', 'transcript_partial', 'transcript_partial',
  ]);
  assert.deepEqual(testHarness.events.map((event: any) => event.revision), [1, 2, 3, 4]);
  assert.equal(testHarness.inputs.length, 1);
  assert.equal((testHarness.inputs[0] as any).transcript, 'phần một phần hai đã sửa');
  assert.equal((testHarness.inputs[0] as any).confidence, 0.8);
});

test('accepts final results delivered while provider finish is draining', async () => {
  const testHarness = harness();
  testHarness.setFinish(async () => {
    testHarness.callbacks.onResult({ text: 'kết quả cuối', isFinal: true, stability: null, confidence: null, resultEndOffset: '0001' });
  });
  const sink = await testHarness.factory.open(token, new AbortController().signal);
  await sink.end(null);
  assert.equal((testHarness.inputs[0] as any).transcript, 'kết quả cuối');
});

test('emits no-speech terminal and never starts downstream for an empty final', async () => {
  const testHarness = harness();
  const sink = await testHarness.factory.open(token, new AbortController().signal);
  await sink.end(null);
  assert.equal(testHarness.inputs.length, 0);
  assert.equal(testHarness.events.at(-1)?.kind, 'terminal');
  assert.equal((testHarness.events.at(-1) as any).code, 'VOICE_NO_SPEECH');
});

test('maps provider failure and cancellation to one terminal control event', async () => {
  const failed = harness();
  failed.setFinish(async () => { throw new StreamingSttError('VOICE_STT_TIMEOUT'); });
  const failedSink = await failed.factory.open(token, new AbortController().signal);
  await assert.rejects(Promise.resolve(failedSink.end(null)), (error: unknown) => error instanceof StreamingSttError);
  assert.equal(failed.events.filter(({ kind }) => kind === 'terminal').length, 1);
  assert.equal((failed.events.at(-1) as any).code, 'VOICE_STT_TIMEOUT');

  const aborted = harness();
  aborted.setFinish(async () => { throw new StreamingSttError('VOICE_CANCELLED'); });
  const abortedSink = await aborted.factory.open(token, new AbortController().signal);
  await assert.rejects(Promise.resolve(abortedSink.end(null)), (error: unknown) => error instanceof StreamingSttError);
  assert.equal(aborted.events.filter(({ kind }) => kind === 'terminal').length, 1);
  assert.equal((aborted.events.at(-1) as any).state, 'CANCELLED');

  const cancelled = harness();
  const cancelledSink = await cancelled.factory.open(token, new AbortController().signal);
  await cancelledSink.cancel('owner_disconnected');
  await cancelledSink.cancel('owner_disconnected');
  assert.equal(cancelled.events.filter(({ kind }) => kind === 'terminal').length, 1);
  assert.equal((cancelled.events.at(-1) as any).state, 'CANCELLED');
});

test('meeting cleanup cancels only active sinks from the target meeting', async () => {
  const testHarness = harness();
  await testHarness.factory.open(token, new AbortController().signal);
  await testHarness.factory.open({ ...token, meetingSessionId: 'meeting-2', turnId: 'turn-2' }, new AbortController().signal);
  await testHarness.factory.cancelMeeting('meeting-1');
  assert.equal(testHarness.providerCancellations, 1);
  await testHarness.factory.cancelMeeting('meeting-1');
  assert.equal(testHarness.providerCancellations, 1);
  await testHarness.factory.cancelMeeting('meeting-2');
  assert.equal(testHarness.providerCancellations, 2);
});

test('turn cancellation targets one streaming sink and is idempotent', async () => {
  const testHarness = harness();
  await testHarness.factory.open(token, new AbortController().signal);
  await testHarness.factory.open({ ...token, turnId: 'turn-2' }, new AbortController().signal);
  assert.equal(await testHarness.factory.cancelTurn('meeting-1', 'turn-1'), true);
  assert.equal(testHarness.providerCancellations, 1);
  assert.equal(await testHarness.factory.cancelTurn('meeting-1', 'turn-1'), false);
  assert.equal(testHarness.providerCancellations, 1);
  assert.equal(await testHarness.factory.cancelTurn('meeting-1', 'turn-2'), true);
  assert.equal(testHarness.providerCancellations, 2);
});
