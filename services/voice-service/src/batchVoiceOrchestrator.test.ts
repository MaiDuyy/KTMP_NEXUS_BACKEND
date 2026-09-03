import assert from 'node:assert/strict';
import test from 'node:test';
import type { VoicePipelineEvent } from '@ott/shared';
import { BatchSttError } from './batchStt.js';
import { BatchVoiceOrchestrator, type BatchVoiceOrchestratorDependencies } from './batchVoiceOrchestrator.js';
import { InternalServiceError } from './internalClients.js';
import { StreamingOutputError } from './streaming/streamingOutputOrchestrator.js';

function upload() {
  return {
    contentType: 'audio/webm',
    audio: Buffer.from('audio'),
    token: {
      userId: 'user-1',
      jti: 'jti-1',
      meetingSessionId: 'call-1',
      turnId: 'turn-1',
      chatId: 'chat-1',
      issuedAtSeconds: 1,
      expiresAtSeconds: 2,
    },
  };
}

function fixture(overrides: Partial<BatchVoiceOrchestratorDependencies> = {}) {
  const events: VoicePipelineEvent[] = [];
  let terminalResolve!: () => void;
  const terminal = new Promise<void>((resolve) => { terminalResolve = resolve; });
  const dependencies: BatchVoiceOrchestratorDependencies = {
    stt: { transcribe: async () => ({ transcript: 'Câu hỏi thử nghiệm', confidence: 0.9 }) },
    ai: {
      answer: async (request) => ({
        conversationId: 1,
        meetingSessionId: request.meetingSessionId,
        turnId: request.turnId,
        displayText: 'Câu trả lời thử nghiệm',
        speechText: 'Câu trả lời thử nghiệm',
        replayed: false,
      }),
    },
    tts: {
      synthesize: async () => ({
        audio: Buffer.from('wav'),
        contentType: 'audio/wav',
        encoding: 'LINEAR16',
        sampleRateHertz: 24_000,
        channelCount: 1,
      }),
    },
    publisher: { publish: async () => ({ completed: true }) },
    control: {
      getContext: async () => ({
        meetingSessionId: 'call-1',
        turnId: 'turn-1',
        ownerUserId: 'user-1',
        ownerName: 'Người dùng Một',
        roomName: 'call-1',
        chatId: 'chat-1',
        workspaceId: 'workspace-1',
        participantIds: ['user-1', 'user-2'],
      }),
      emit: async (event) => {
        events.push(event);
        if (event.kind === 'terminal') terminalResolve();
      },
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    } as any,
    timeoutMs: 5_000,
    ...overrides,
  };
  return { orchestrator: new BatchVoiceOrchestrator(dependencies), events, terminal };
}

test('runs the complete batch pipeline and unlocks only after LiveKit publish', async () => {
  let published = false;
  const { orchestrator, events, terminal } = fixture({
    publisher: {
      publish: async () => {
        published = true;
        return { completed: true };
      },
    },
  });

  assert.equal(orchestrator.enqueue(upload()), true);
  assert.equal(orchestrator.enqueue(upload()), false);
  await terminal;

  assert.deepEqual(events.map((event) => event.kind === 'state' ? event.state : event.kind), [
    'FINALIZING_STT',
    'transcript',
    'THINKING',
    'message',
    'RESPONDING',
    'terminal',
  ]);
  assert.equal(events.at(-1)?.kind, 'terminal');
  assert.equal((events.at(-1) as any).state, 'COMPLETED');
  assert.equal(published, true);
});

test('maps provider failure to a terminal event without invoking later stages', async () => {
  let aiCalled = false;
  const pipelines: Array<{ outcome: string; code: string }> = [];
  const { orchestrator, events, terminal } = fixture({
    stt: { transcribe: async () => { throw new BatchSttError('VOICE_NO_SPEECH'); } },
    ai: { answer: async () => { aiCalled = true; throw new Error('unexpected'); } },
    metrics: {
      recordStage: () => undefined,
      recordPipeline: (outcome, code) => { pipelines.push({ outcome, code }); },
    },
  });

  orchestrator.enqueue(upload());
  await terminal;

  assert.equal(aiCalled, false);
  assert.deepEqual(events.map(({ kind }) => kind), ['state', 'terminal']);
  assert.equal((events.at(-1) as any).state, 'FAILED');
  assert.equal((events.at(-1) as any).code, 'VOICE_NO_SPEECH');
  assert.deepEqual(pipelines, [{ outcome: 'failed', code: 'VOICE_NO_SPEECH' }]);
});

test('does not emit a stale terminal event after Gateway reports expired ownership', async () => {
  const events: VoicePipelineEvent[] = [];
  const { orchestrator } = fixture({
    control: {
      getContext: async () => { throw new InternalServiceError('VOICE_CANCELLED'); },
      emit: async (event) => { events.push(event); },
    },
  });

  orchestrator.enqueue(upload());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(events, []);
});

test('cancels every active stage by meeting and rejects enqueue after meeting end', async () => {
  let sttAborted = false;
  const pipelines: Array<{ outcome: string; code: string }> = [];
  const { orchestrator, events } = fixture({
    stt: {
      transcribe: async (_audio, _mimeType, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          sttAborted = true;
          reject(new BatchSttError('VOICE_CANCELLED'));
        }, { once: true });
      }),
    },
    metrics: {
      recordStage: () => undefined,
      recordPipeline: (outcome, code) => { pipelines.push({ outcome, code }); },
    },
  });

  assert.equal(orchestrator.enqueue(upload()), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await orchestrator.cancelMeeting('call-1');
  assert.equal(sttAborted, true);
  assert.deepEqual(events.map(({ kind }) => kind), ['state']);
  assert.equal(orchestrator.enqueue(upload()), false);
  assert.deepEqual(pipelines, [{ outcome: 'cancelled', code: 'VOICE_CANCELLED' }]);
});

test('records bounded stage and pipeline metrics for a completed turn', async () => {
  const stages: Array<{ stage: string; outcome: string }> = [];
  const pipelines: Array<{ outcome: string; code: string }> = [];
  const { orchestrator, terminal } = fixture({
    metrics: {
      recordStage: (stage, outcome) => { stages.push({ stage, outcome }); },
      recordPipeline: (outcome, code) => { pipelines.push({ outcome, code }); },
    },
  });

  assert.equal(orchestrator.enqueue(upload()), true);
  await terminal;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stages, [
    { stage: 'context', outcome: 'completed' },
    { stage: 'stt', outcome: 'completed' },
    { stage: 'ai', outcome: 'completed' },
    { stage: 'tts', outcome: 'completed' },
    { stage: 'livekit', outcome: 'completed' },
  ]);
  assert.deepEqual(pipelines, [{ outcome: 'completed', code: 'none' }]);
});

test('falls back to batch exactly once when streaming output fails before first frame after AI done', async () => {
  let batchTtsCalls = 0;
  let batchPublishCalls = 0;
  const outputOutcomes: string[] = [];
  const { orchestrator, events, terminal } = fixture({
    ai: {
      answer: async () => { throw new Error('batch AI must not run'); },
      stream: async function* () { yield { type: 'done', version: 1, turnId: 'turn-1', replayed: false }; },
    },
    streamingOutput: {
      run: async (input) => {
        await input.onSideChannelEvent?.({ type: 'display.delta', version: 1, turnId: 'turn-1', sequence: 0, text: 'Câu trả lời.' });
        throw new StreamingOutputError(true, false, 'Câu trả lời.');
      },
    },
    tts: { synthesize: async () => { batchTtsCalls += 1; return { audio: Buffer.from('wav'), contentType: 'audio/wav', encoding: 'LINEAR16', sampleRateHertz: 24_000, channelCount: 1 }; } },
    publisher: { publish: async (input) => { batchPublishCalls += 1; input.onFirstFrame?.(); return { completed: true }; } },
    metrics: {
      recordStage: () => undefined,
      recordPipeline: () => undefined,
      recordStreamingOutput: (outcome: string) => { outputOutcomes.push(outcome); },
    } as any,
  });
  orchestrator.enqueue(upload());
  await terminal;
  assert.equal(batchTtsCalls, 1);
  assert.equal(batchPublishCalls, 1);
  assert.deepEqual(outputOutcomes, ['fallback_batch_before_first_audio']);
  assert.deepEqual(events.filter((event) => event.kind === 'message').length, 1);
});

test('never replays with batch fallback after a streaming frame was published', async () => {
  let batchTtsCalls = 0;
  const { orchestrator, events, terminal } = fixture({
    ai: { answer: async () => { throw new Error('not used'); }, stream: async function* () { yield { type: 'done', version: 1, turnId: 'turn-1', replayed: false }; } },
    streamingOutput: { run: async () => { throw new StreamingOutputError(true, true, 'Đã phát một phần.'); } },
    tts: { synthesize: async () => { batchTtsCalls += 1; throw new Error('must not run'); } },
  });
  orchestrator.enqueue(upload());
  await terminal;
  assert.equal(batchTtsCalls, 0);
  assert.equal((events.at(-1) as any).state, 'FAILED');
});
