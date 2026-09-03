import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import type { CallRegistryMeta, RedisCallParticipantRegistry } from '../calls/callRegistry.js';
import type { RedisVoiceLockService, VoiceLockOwner } from './voiceLockService.js';
import {
  VOICE_TURN_TOKEN_AUDIENCE,
  VOICE_TURN_TOKEN_ISSUER,
  VoiceTurnTokenIssuer,
} from './turnTokenService.js';
import { VoiceTurnController, type VoiceRoomBroadcaster, type VoiceSocket } from './voiceTurnController.js';
import type { VoiceActiveTurn, VoiceHistoryMessage, VoicePipelineEvent, VoiceTurnState } from '@ott/shared';
import type { VoiceSessionStore } from './voiceSessionStore.js';

class FakeSocket implements VoiceSocket {
  public readonly events: Array<{ event: string; payload: any }> = [];
  public readonly rooms = new Set<string>();

  public emit(event: string, payload: unknown): boolean {
    this.events.push({ event, payload });
    return true;
  }

  public join(room: string): void {
    this.rooms.add(room);
  }
}

class FakeBroadcaster implements VoiceRoomBroadcaster {
  public readonly events: Array<{ room: string; event: string; payload: any }> = [];

  public to(room: string) {
    return {
      emit: (event: string, payload: unknown) => {
        this.events.push({ room, event, payload });
        return true;
      },
    };
  }
}

class FakeCallRegistry {
  public meta: CallRegistryMeta | null = {
    meetingSessionId: 'call-1',
    roomName: 'call-1',
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    status: 'active',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
  public readonly participants = new Set(['user-1']);

  public async getMeta(): Promise<CallRegistryMeta | null> {
    return this.meta;
  }

  public async hasParticipant(_meetingSessionId: string, userId: string): Promise<boolean> {
    return this.participants.has(userId);
  }

  public async getParticipantIds(): Promise<string[]> {
    return [...this.participants];
  }
}

class FakeVoiceLockService {
  public owner: VoiceLockOwner | null = null;
  public releaseAttempts = 0;
  public refreshAllowed = true;

  public async acquire(meetingSessionId: string, turnId: string, ownerUserId: string) {
    if (this.owner) {
      return null;
    }

    this.owner = { turnId, ownerUserId };
    return {
      meetingSessionId,
      turnId,
      ownerUserId,
      token: 'lock-token',
      lockValue: 'lock-value',
    };
  }

  public async get(): Promise<VoiceLockOwner | null> {
    return this.owner;
  }

  public async release(): Promise<boolean> {
    this.owner = null;
    return true;
  }

  public async releaseByOwner(_meetingSessionId: string, turnId: string, ownerUserId: string): Promise<boolean> {
    this.releaseAttempts += 1;
    if (!this.owner || this.owner.turnId !== turnId || this.owner.ownerUserId !== ownerUserId) {
      return false;
    }

    this.owner = null;
    return true;
  }

  public async refreshByOwner(_meetingSessionId: string, turnId: string, ownerUserId: string): Promise<boolean> {
    return this.refreshAllowed && this.owner?.turnId === turnId && this.owner.ownerUserId === ownerUserId;
  }
}

class FakeVoiceSessionStore implements VoiceSessionStore {
  public active: VoiceActiveTurn | null = null;
  public readonly history: VoiceHistoryMessage[] = [];

  public async activate(_meetingSessionId: string, activeTurn: VoiceActiveTurn): Promise<void> {
    this.active = activeTurn;
  }
  public async updateState(_meetingSessionId: string, turnId: string, ownerUserId: string, state: VoiceTurnState): Promise<boolean> {
    if (!this.active || this.active.turnId !== turnId || this.active.ownerUserId !== ownerUserId) return false;
    this.active = { ...this.active, state };
    return true;
  }
  public async appendHistory(_meetingSessionId: string, turnId: string, ownerUserId: string, message: VoiceHistoryMessage): Promise<boolean> {
    if (!this.active || this.active.turnId !== turnId || this.active.ownerUserId !== ownerUserId) return false;
    if (!this.history.some(({ id }) => id === message.id)) this.history.push(message);
    return true;
  }
  public async clearActive(_meetingSessionId: string, turnId: string, ownerUserId: string): Promise<boolean> {
    if (!this.active || this.active.turnId !== turnId || this.active.ownerUserId !== ownerUserId) return false;
    this.active = null;
    return true;
  }
  public async getActive(): Promise<VoiceActiveTurn | null> { return this.active; }
  public async getHistory(): Promise<VoiceHistoryMessage[]> { return this.history; }
  public async clearSession(): Promise<void> { this.active = null; this.history.length = 0; }
}

function createController(options: {
  featureEnabled?: boolean;
  allowedWorkspaceIds?: string[];
  startOutcomes?: string[];
  transportSelections?: string[];
  cancellationCalls?: Array<{ meetingSessionId: string; turnId: string; cancellationId: string }>;
  cancellationError?: Error;
  cancellationOutcomes?: Array<{ reason: string; outcome: string }>;
  recoveryOutcomes?: string[];
} = {}) {
  const broadcaster = new FakeBroadcaster();
  const callRegistry = new FakeCallRegistry();
  const voiceLockService = new FakeVoiceLockService();
  const voiceSessionStore = new FakeVoiceSessionStore();
  const issuer = new VoiceTurnTokenIssuer({ secret: 'test-voice-turn-secret-with-sufficient-length' });
  const controller = new VoiceTurnController({
    broadcaster,
    callRegistry: callRegistry as unknown as RedisCallParticipantRegistry,
    voiceLockService: voiceLockService as unknown as RedisVoiceLockService,
    voiceSessionStore,
    tokenIssuer: issuer,
    voicePublicApiUrl: 'http://gateway.example.test/api',
    voicePublicStreamUrl: 'wss://voice.example.test',
    featurePolicy: {
      enabled: options.featureEnabled ?? true,
      allowedWorkspaceIds: new Set(options.allowedWorkspaceIds ?? []),
      isWorkspaceAllowed: (workspaceId) => (options.featureEnabled ?? true) && (
        !options.allowedWorkspaceIds?.length || options.allowedWorkspaceIds.includes(workspaceId)
      ),
    },
    metrics: {
      recordStart: (outcome) => options.startOutcomes?.push(outcome),
      recordTerminal: () => undefined,
      recordTransportSelection: (selection) => options.transportSelections?.push(selection),
      recordCancellation: (reason, outcome) => options.cancellationOutcomes?.push({ reason, outcome }),
      recordRecovery: (outcome) => options.recoveryOutcomes?.push(outcome),
    },
    turnCancellation: {
      cancelTurn: async (meetingSessionId, turnId, cancellationId) => {
        options.cancellationCalls?.push({ meetingSessionId, turnId, cancellationId });
        if (options.cancellationError) throw options.cancellationError;
      },
    },
  });

  return { broadcaster, callRegistry, voiceLockService, voiceSessionStore, controller };
}

test('VoiceTurnTokenIssuer creates short-lived Voice Service credentials with bound claims', () => {
  const issuer = new VoiceTurnTokenIssuer({ secret: 'test-voice-turn-secret-with-sufficient-length', ttlSeconds: 90 });
  const issued = issuer.issue(
    { userId: 'user-1', meetingSessionId: 'call-1', turnId: 'turn-1', chatId: 'chat-1' },
    new Date('2026-08-28T00:00:00.000Z'),
  );
  const decoded = jwt.verify(issued.token, 'test-voice-turn-secret-with-sufficient-length', {
    algorithms: ['HS256'],
    audience: VOICE_TURN_TOKEN_AUDIENCE,
    issuer: VOICE_TURN_TOKEN_ISSUER,
  }) as jwt.JwtPayload;

  assert.equal(decoded.sub, 'user-1');
  assert.equal(decoded.meetingSessionId, 'call-1');
  assert.equal(decoded.turnId, 'turn-1');
  assert.equal(decoded.chatId, 'chat-1');
  assert.equal(decoded.exp! - decoded.iat!, 90);
  assert.equal(issued.expiresAt, '2026-08-28T00:01:30.000Z');
});

test('VoiceTurnController rejects a disabled workspace before acquiring a lock or issuing a token', async () => {
  const outcomes: string[] = [];
  const { controller, voiceLockService, voiceSessionStore } = createController({
    allowedWorkspaceIds: ['workspace-allowed'],
    startOutcomes: outcomes,
  });
  const socket = new FakeSocket();

  await controller.start({
    socket,
    userId: 'user-1',
    userName: 'User One',
    payload: {
      meetingSessionId: 'call-1',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      clientRequestId: 'request-disabled',
      mode: 'rag',
    },
  });

  assert.equal(voiceLockService.owner, null);
  assert.equal(await voiceSessionStore.getActive(), null);
  assert.deepEqual(outcomes, ['feature_disabled']);
  assert.equal(socket.events.at(-1)?.event, 'voice:error');
  assert.equal((socket.events.at(-1)?.payload as { code: string }).code, 'VOICE_FEATURE_DISABLED');
});

test('VoiceTurnTokenIssuer rejects weak secrets and TTL values above the replay window', () => {
  assert.throws(() => new VoiceTurnTokenIssuer({ secret: 'too-short' }), /at least 32/);
  assert.throws(
    () => new VoiceTurnTokenIssuer({ secret: 'test-voice-turn-secret-with-sufficient-length', ttlSeconds: 121 }),
    /from 1 to 120/,
  );
});

test('VoiceTurnController denies a user outside the active call registry', async () => {
  const { controller, voiceLockService } = createController();
  const socket = new FakeSocket();

  await controller.start({
    socket,
    userId: 'user-2',
    userName: 'User Two',
    payload: {
      meetingSessionId: 'call-1',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      clientRequestId: 'request-1',
      mode: 'rag',
    },
  });

  assert.equal(voiceLockService.owner, null);
  assert.deepEqual(socket.events.at(-1)?.payload, {
    meetingSessionId: 'call-1',
    turnId: null,
    code: 'VOICE_NOT_IN_CALL',
    message: 'Bạn không ở trong cuộc gọi này.',
    retryable: false,
  });
});

test('VoiceTurnController keeps the lock after speech ends and releases only its owner cancellation', async () => {
  const cancellationCalls: Array<{ meetingSessionId: string; turnId: string; cancellationId: string }> = [];
  const cancellationOutcomes: Array<{ reason: string; outcome: string }> = [];
  const { broadcaster, callRegistry, controller, voiceLockService } = createController({ cancellationCalls, cancellationOutcomes });
  const ownerSocket = new FakeSocket();
  const otherSocket = new FakeSocket();
  const startPayload = {
    meetingSessionId: 'call-1',
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    clientRequestId: 'request-1',
    mode: 'rag' as const,
    transportMode: 'streaming' as const,
  };

  await controller.start({ socket: ownerSocket, userId: 'user-1', userName: 'User One', payload: startPayload });

  const accepted = ownerSocket.events.find(({ event }) => event === 'voice:turn:accepted');
  assert.ok(accepted);
  assert.match(accepted.payload.uploadUrl, /\/api\/voice\/turns\/.+\/audio$/);
  assert.match(accepted.payload.streamUrl, /^wss:\/\/voice\.example\.test\/v1\/voice\/turns\/.+\/stream$/);
  assert.equal(accepted.payload.stream.protocolVersion, 1);
  assert.equal(accepted.payload.stream.audioFormat.sampleRateHz, 16000);
  assert.equal(ownerSocket.rooms.has('call:call-1'), true);
  assert.equal(broadcaster.events.some(({ event }) => event === 'voice:lock:changed'), true);

  callRegistry.participants.add('user-2');
  await controller.end({
    socket: otherSocket,
    userId: 'user-2',
    userName: 'User Two',
    payload: { meetingSessionId: 'call-1', turnId: accepted.payload.turnId },
  });
  assert.equal(voiceLockService.owner?.ownerUserId, 'user-1');
  assert.equal(otherSocket.events.at(-1)?.payload.code, 'VOICE_TURN_NOT_OWNER');

  await controller.end({
    socket: ownerSocket,
    userId: 'user-1',
    userName: 'User One',
    payload: { meetingSessionId: 'call-1', turnId: accepted.payload.turnId },
  });
  assert.equal(voiceLockService.owner?.ownerUserId, 'user-1');
  assert.equal(broadcaster.events.at(-1)?.payload.state, 'FINALIZING_STT');

  await controller.cancel({
    socket: ownerSocket,
    userId: 'user-1',
    userName: 'User One',
    payload: { meetingSessionId: 'call-1', turnId: accepted.payload.turnId, reason: 'user_cancelled' },
  });
  assert.equal(voiceLockService.owner, null);
  assert.equal(voiceLockService.releaseAttempts, 1);
  assert.equal(cancellationCalls.length, 1);
  assert.equal(cancellationCalls[0].turnId, accepted.payload.turnId);
  assert.deepEqual(cancellationOutcomes, [{ reason: 'user_cancelled', outcome: 'completed' }]);
  assert.equal(broadcaster.events.some(({ event, payload }) => event === 'voice:state' && payload.state === 'CANCELLING'), true);
  assert.equal(broadcaster.events.at(-1)?.event, 'voice:ready');

  ownerSocket.events.length = 0;
  await controller.cancel({
    socket: ownerSocket,
    userId: 'user-1',
    userName: 'User One',
    payload: { meetingSessionId: 'call-1', turnId: accepted.payload.turnId, reason: 'user_cancelled' },
  });
  assert.equal(cancellationCalls.length, 1);
  assert.equal(ownerSocket.events.some(({ event }) => event === 'voice:error'), false);
  assert.deepEqual(cancellationOutcomes.at(-1), { reason: 'user_cancelled', outcome: 'stale' });
});

test('keeps ownership when Voice Service turn cancellation fails', async () => {
  const outcomes: Array<{ reason: string; outcome: string }> = [];
  const { controller, voiceLockService, voiceSessionStore } = createController({
    cancellationError: new Error('voice service unavailable'),
    cancellationOutcomes: outcomes,
  });
  const socket = new FakeSocket();
  await controller.start({
    socket, userId: 'user-1', userName: 'User One',
    payload: { meetingSessionId: 'call-1', chatId: 'chat-1', workspaceId: 'workspace-1', clientRequestId: 'cancel-fail', mode: 'rag' },
  });
  const turnId = socket.events.find(({ event }) => event === 'voice:turn:accepted')!.payload.turnId;
  await assert.rejects(controller.cancel({
    socket, userId: 'user-1', userName: 'User One',
    payload: { meetingSessionId: 'call-1', turnId, reason: 'user_cancelled' },
  }), /voice service unavailable/);
  assert.equal(voiceLockService.owner?.turnId, turnId);
  assert.equal(voiceSessionStore.active?.state, 'CANCELLING');
  assert.deepEqual(outcomes, [{ reason: 'user_cancelled', outcome: 'failed' }]);
});

test('refreshes ownership before finalizing and rejects an expired lock', async () => {
  const { controller, voiceLockService, voiceSessionStore } = createController();
  const socket = new FakeSocket();
  await controller.start({
    socket, userId: 'user-1', userName: 'User One',
    payload: { meetingSessionId: 'call-1', chatId: 'chat-1', workspaceId: 'workspace-1', clientRequestId: 'refresh', mode: 'rag' },
  });
  const turnId = socket.events.find(({ event }) => event === 'voice:turn:accepted')!.payload.turnId;
  voiceLockService.refreshAllowed = false;
  await controller.end({ socket, userId: 'user-1', userName: 'User One', payload: { meetingSessionId: 'call-1', turnId } });
  assert.equal(voiceSessionStore.active?.state, 'LISTENING');
  assert.equal(socket.events.at(-1)?.payload.code, 'VOICE_TURN_EXPIRED');
});

test('clears a stale active session during bounded session sync', async () => {
  const recoveries: string[] = [];
  const { controller, callRegistry, voiceSessionStore } = createController({ recoveryOutcomes: recoveries });
  callRegistry.participants.add('user-2');
  voiceSessionStore.active = { turnId: 'stale-turn', ownerUserId: 'user-1', ownerName: 'User One', state: 'THINKING' };
  const response = await controller.sync({
    socket: new FakeSocket(), userId: 'user-2', userName: 'User Two', payload: { meetingSessionId: 'call-1' },
  });
  assert.equal(response?.activeTurn, null);
  assert.equal(voiceSessionStore.active, null);
  assert.deepEqual(recoveries, ['stale_session_cleared']);
});

test('participant departure cancels only the departing owner turn', async () => {
  const cancellationCalls: Array<{ meetingSessionId: string; turnId: string; cancellationId: string }> = [];
  const cancellationOutcomes: Array<{ reason: string; outcome: string }> = [];
  const { controller, callRegistry, voiceLockService } = createController({ cancellationCalls, cancellationOutcomes });
  const socket = new FakeSocket();
  await controller.start({
    socket, userId: 'user-1', userName: 'User One',
    payload: { meetingSessionId: 'call-1', chatId: 'chat-1', workspaceId: 'workspace-1', clientRequestId: 'departure', mode: 'rag' },
  });
  const turnId = socket.events.find(({ event }) => event === 'voice:turn:accepted')!.payload.turnId;

  callRegistry.participants.add('user-2');
  await controller.cancelForParticipantDeparture('call-1', 'user-2');
  assert.equal(voiceLockService.owner?.turnId, turnId);
  assert.equal(cancellationCalls.length, 0);

  await controller.cancelForParticipantDeparture('call-1', 'user-1');
  assert.equal(voiceLockService.owner, null);
  assert.equal(cancellationCalls.length, 1);
  assert.equal(cancellationCalls[0].turnId, turnId);
  assert.deepEqual(cancellationOutcomes, [{ reason: 'owner_disconnected', outcome: 'completed' }]);
});

test('issues streaming credentials only when the client selected streaming', async () => {
  const selections: string[] = [];
  const { controller } = createController({ transportSelections: selections });
  const socket = new FakeSocket();
  await controller.start({
    socket,
    userId: 'user-1',
    userName: 'User One',
    payload: {
      meetingSessionId: 'call-1',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      clientRequestId: 'request-batch',
      mode: 'rag',
      transportMode: 'batch',
    },
  });
  const accepted = socket.events.find(({ event }) => event === 'voice:turn:accepted')!.payload;
  assert.equal(accepted.streamUrl, '');
  assert.equal(accepted.stream, undefined);
  assert.deepEqual(selections, ['batch_capability']);
});

test('VoiceTurnController fans out pipeline events and synchronizes transient history', async () => {
  const { broadcaster, callRegistry, controller, voiceLockService } = createController();
  const ownerSocket = new FakeSocket();
  const observerSocket = new FakeSocket();
  callRegistry.participants.add('user-2');

  await controller.start({
    socket: ownerSocket,
    userId: 'user-1',
    userName: 'User One',
    payload: {
      meetingSessionId: 'call-1',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      clientRequestId: 'request-sync',
      mode: 'rag',
    },
  });
  const accepted = ownerSocket.events.find(({ event }) => event === 'voice:turn:accepted')!.payload;
  const base = { meetingSessionId: 'call-1', turnId: accepted.turnId, ownerUserId: 'user-1' };

  assert.equal(await controller.handlePipelineEvent({ ...base, kind: 'state', state: 'THINKING' }), true);
  assert.equal(await controller.handlePipelineEvent({
    ...base,
    kind: 'transcript_partial',
    speakerName: 'ignored-service-value',
    text: 'Câu hỏi đang nhận',
    stability: 0.7,
    revision: 1,
  }), true);
  assert.equal((broadcaster.events.at(-1)?.payload as { isFinal: boolean }).isFinal, false);
  assert.equal((broadcaster.events.at(-1)?.payload as { revision: number }).revision, 1);
  assert.equal((await controller.sync({
    socket: observerSocket,
    userId: 'user-2',
    userName: 'User Two',
    payload: { meetingSessionId: 'call-1' },
  }))?.messages.length, 0);
  assert.equal(await controller.handlePipelineEvent({
    ...base,
    kind: 'transcript',
    speakerName: 'ignored-service-value',
    text: 'Câu hỏi đã nhận diện',
    confidence: 0.92,
  }), true);
  assert.equal(await controller.handlePipelineEvent({
    ...base,
    kind: 'message_partial',
    displayText: 'Câu trả lời đang stream',
    revision: 2,
    sources: [{ documentId: 'doc-1', title: 'Tài liệu', chunkId: 'chunk-1' }],
  }), true);
  const partialEvent = broadcaster.events.at(-1);
  assert.equal(partialEvent?.event, 'voice:message');
  assert.equal((partialEvent?.payload as { isFinal: boolean }).isFinal, false);
  assert.equal((await controller.sync({
    socket: observerSocket,
    userId: 'user-2',
    userName: 'User Two',
    payload: { meetingSessionId: 'call-1' },
  }))?.messages.length, 1);
  assert.equal(await controller.handlePipelineEvent({
    ...base,
    kind: 'message',
    displayText: 'Câu trả lời của AI',
    sources: [],
  }), true);

  const sync = await controller.sync({
    socket: observerSocket,
    userId: 'user-2',
    userName: 'User Two',
    payload: { meetingSessionId: 'call-1' },
  });
  assert.equal(sync?.activeTurn?.state, 'THINKING');
  assert.equal(sync?.activeTurn?.ownerName, 'User One');
  assert.deepEqual(sync?.messages.map(({ role, displayText }) => ({ role, displayText })), [
    { role: 'user', displayText: 'Câu hỏi đã nhận diện' },
    { role: 'assistant', displayText: 'Câu trả lời của AI' },
  ]);
  assert.equal(broadcaster.events.some(({ event }) => event === 'voice:transcript'), true);
  assert.equal(broadcaster.events.some(({ event }) => event === 'voice:message'), true);

  const malformedTerminal = { ...base, kind: 'terminal', state: 'UNLOCK' } as unknown as VoicePipelineEvent;
  assert.equal(await controller.handlePipelineEvent(malformedTerminal), false);
  assert.equal(voiceLockService.owner?.turnId, accepted.turnId);

  assert.equal(await controller.handlePipelineEvent({ ...base, kind: 'terminal', state: 'COMPLETED' }), true);
  assert.equal(voiceLockService.owner, null);
  assert.equal(await controller.handlePipelineEvent({ ...base, kind: 'terminal', state: 'COMPLETED' }), false);
});

test('VoiceTurnController rejects workspace spoofing before acquiring a lock', async () => {
  const { controller, voiceLockService } = createController();
  const socket = new FakeSocket();
  await controller.start({
    socket,
    userId: 'user-1',
    userName: 'User One',
    payload: {
      meetingSessionId: 'call-1',
      chatId: 'chat-1',
      workspaceId: 'other-workspace',
      clientRequestId: 'request-spoof',
      mode: 'rag',
    },
  });
  assert.equal(voiceLockService.owner, null);
  assert.equal(socket.events.at(-1)?.payload.code, 'VOICE_NOT_IN_CALL');
});

test('call cleanup clears transient history even when no active lock remains', async () => {
  const { controller, voiceSessionStore } = createController();
  voiceSessionStore.history.push({
    id: 'old:user',
    turnId: 'old',
    role: 'user',
    speakerUserId: 'user-1',
    speakerName: 'User One',
    displayText: 'old transcript',
    createdAt: '2026-08-30T00:00:00.000Z',
    status: 'COMPLETED',
  });

  await controller.cancelForCallCleanup('call-1');
  assert.equal(voiceSessionStore.active, null);
  assert.deepEqual(voiceSessionStore.history, []);
});
