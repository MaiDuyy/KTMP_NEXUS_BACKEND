import assert from 'node:assert/strict';
import test from 'node:test';
import type { VoicePipelineEvent } from '@ott/shared';
import { BatchVoiceOrchestrator } from './batchVoiceOrchestrator.js';

test('runs three alternating batch turns with stable meeting context and terminal-after-publish ordering', async () => {
  const meetingSessionId = 'p1-11-batch-meeting';
  const speakers = ['user-1', 'user-2', 'user-1'];
  const events = new Map<string, VoicePipelineEvent[]>();
  const answers: Array<{ meetingSessionId: string; ownerUserId: string; turnId: string }> = [];
  const published = new Set<string>();
  const terminalResolvers = new Map<string, () => void>();
  const orchestrator = new BatchVoiceOrchestrator({
    stt: {
      transcribe: async (audio) => ({
        transcript: 'question-' + audio.toString('utf8'),
        confidence: 0.99,
      }),
    },
    ai: {
      answer: async (request) => {
        answers.push({
          meetingSessionId: request.meetingSessionId,
          ownerUserId: request.speakerUserId,
          turnId: request.turnId,
        });
        return {
          conversationId: 11,
          meetingSessionId: request.meetingSessionId,
          turnId: request.turnId,
          displayText: 'answer-' + answers.length,
          speechText: 'answer-' + answers.length,
          replayed: false,
        };
      },
    },
    tts: {
      synthesize: async (text) => ({
        audio: Buffer.from(text),
        contentType: 'audio/wav',
        encoding: 'LINEAR16',
        sampleRateHertz: 24_000,
        channelCount: 1,
      }),
    },
    publisher: {
      publish: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        published.add(input.turnId);
        return { completed: true };
      },
    },
    control: {
      getContext: async (request) => ({
        meetingSessionId: request.meetingSessionId,
        turnId: request.turnId,
        ownerUserId: request.ownerUserId,
        ownerName: request.ownerUserId,
        roomName: request.meetingSessionId,
        chatId: 'chat-1',
        workspaceId: 'workspace-1',
        participantIds: ['user-1', 'user-2'],
      }),
      emit: async (event) => {
        const turnEvents = events.get(event.turnId) ?? [];
        turnEvents.push(event);
        events.set(event.turnId, turnEvents);
        if (event.kind === 'terminal') {
          assert.equal(published.has(event.turnId), true);
          terminalResolvers.get(event.turnId)?.();
        }
      },
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    },
    timeoutMs: 5_000,
  });

  for (const [index, ownerUserId] of speakers.entries()) {
    const turnId = 'turn-' + (index + 1);
    const terminal = new Promise<void>((resolve) => terminalResolvers.set(turnId, resolve));
    assert.equal(orchestrator.enqueue({
      contentType: 'audio/webm',
      audio: Buffer.from(String(index + 1)),
      token: {
        userId: ownerUserId,
        jti: 'jti-' + (index + 1),
        meetingSessionId,
        turnId,
        chatId: 'chat-1',
        issuedAtSeconds: 1,
        expiresAtSeconds: 2,
      },
    }), true);
    await terminal;
  }

  assert.deepEqual(answers.map(({ meetingSessionId: id, ownerUserId }) => ({ id, ownerUserId })), [
    { id: meetingSessionId, ownerUserId: 'user-1' },
    { id: meetingSessionId, ownerUserId: 'user-2' },
    { id: meetingSessionId, ownerUserId: 'user-1' },
  ]);
  for (const turnEvents of events.values()) {
    assert.deepEqual(turnEvents.map((event) => event.kind === 'state' ? event.state : event.kind), [
      'FINALIZING_STT',
      'transcript',
      'THINKING',
      'message',
      'RESPONDING',
      'terminal',
    ]);
    assert.equal((turnEvents.at(-1) as Extract<VoicePipelineEvent, { kind: 'terminal' }>).state, 'COMPLETED');
  }
});
