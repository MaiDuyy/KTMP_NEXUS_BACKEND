import assert from 'node:assert/strict';
import test from 'node:test';
import { MeetingCleanupCoordinator } from './meetingCleanupCoordinator.js';
import type { BatchVoiceOrchestrator } from './batchVoiceOrchestrator.js';
import type { MeetingAiClient } from './internalClients.js';
import type { MeetingAudioPublisher } from './livekit/MeetingAudioPublisher.js';
import type { VoiceServiceLogger } from './logger.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as VoiceServiceLogger;

test('meeting cleanup is concurrent-idempotent and follows ending, cancel, close, cleanup order', async () => {
  const order: string[] = [];
  let releaseEnding!: () => void;
  const endingGate = new Promise<void>((resolve) => { releaseEnding = resolve; });
  const coordinator = new MeetingCleanupCoordinator({
    streaming: { cancelMeeting: async () => { order.push('stream-cancel'); } },
    orchestrator: { cancelMeeting: async () => { order.push('cancel'); } } as unknown as BatchVoiceOrchestrator,
    publisher: { closeMeeting: async () => { order.push('close'); } } as unknown as MeetingAudioPublisher,
    meetingAi: {
      beginMeetingCleanup: async () => { order.push('ending'); await endingGate; },
      completeMeetingCleanup: async () => { order.push('cleanup'); },
    } as unknown as MeetingAiClient,
    logger,
    timeoutMs: 5_000,
  });

  const first = coordinator.cleanup('call-1', 'cleanup-1');
  const duplicate = coordinator.cleanup('call-1', 'cleanup-1');
  assert.equal(first, duplicate);
  releaseEnding();
  await first;
  assert.deepEqual(order, ['ending', 'stream-cancel', 'cancel', 'close', 'cleanup']);
});

test('meeting cleanup attempts later resources when an earlier step fails', async () => {
  const attempted: string[] = [];
  const coordinator = new MeetingCleanupCoordinator({
    streaming: { cancelMeeting: async () => { attempted.push('stream-cancel'); throw new Error('stream failed'); } },
    orchestrator: { cancelMeeting: async () => { attempted.push('cancel'); throw new Error('cancel failed'); } } as unknown as BatchVoiceOrchestrator,
    publisher: { closeMeeting: async () => { attempted.push('close'); } } as unknown as MeetingAudioPublisher,
    meetingAi: {
      beginMeetingCleanup: async () => { attempted.push('ending'); },
      completeMeetingCleanup: async () => { attempted.push('cleanup'); },
    } as unknown as MeetingAiClient,
    logger,
    timeoutMs: 5_000,
  });

  await assert.rejects(() => coordinator.cleanup('call-1', 'cleanup-1'));
  assert.deepEqual(attempted, ['ending', 'stream-cancel', 'cancel', 'close', 'cleanup']);
});

test('cleans AI state and LiveKit safely when no batch pipeline was configured', async () => {
  const attempted: string[] = [];
  const coordinator = new MeetingCleanupCoordinator({
    orchestrator: null,
    publisher: { closeMeeting: async () => { attempted.push('close'); } } as unknown as MeetingAudioPublisher,
    meetingAi: {
      beginMeetingCleanup: async () => { attempted.push('ending'); },
      completeMeetingCleanup: async () => { attempted.push('cleanup'); },
    } as unknown as MeetingAiClient,
    logger,
    timeoutMs: 5_000,
  });

  await coordinator.cleanup('call-1', 'cleanup-1');
  assert.deepEqual(attempted, ['ending', 'close', 'cleanup']);
});
