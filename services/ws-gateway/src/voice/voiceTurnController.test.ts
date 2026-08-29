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
    return this.owner?.turnId === turnId && this.owner.ownerUserId === ownerUserId;
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

function createController() {
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
  const { broadcaster, callRegistry, controller, voiceLockService } = createController();
  const ownerSocket = new FakeSocket();
  const otherSocket = new FakeSocket();
  const startPayload = {
    meetingSessionId: 'call-1',
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    clientRequestId: 'request-1',
    mode: 'rag' as const,
  };

  await controller.start({ socket: ownerSocket, userId: 'user-1', userName: 'User One', payload: startPayload });

  const accepted = ownerSocket.events.find(({ event }) => event === 'voice:turn:accepted');
  assert.ok(accepted);
  assert.match(accepted.payload.uploadUrl, /\/api\/voice\/turns\/.+\/audio$/);
  assert.match(accepted.payload.streamUrl, /\/api\/voice\/turns\/.+\/stream$/);
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
  assert.equal(broadcaster.events.at(-1)?.event, 'voice:ready');
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
    kind: 'transcript',
    speakerName: 'ignored-service-value',
    text: 'Câu hỏi đã nhận diện',
    confidence: 0.92,
  }), true);
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
