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
}

function createController() {
  const broadcaster = new FakeBroadcaster();
  const callRegistry = new FakeCallRegistry();
  const voiceLockService = new FakeVoiceLockService();
  const issuer = new VoiceTurnTokenIssuer({ secret: 'test-voice-turn-secret-with-sufficient-length' });
  const controller = new VoiceTurnController({
    broadcaster,
    callRegistry: callRegistry as unknown as RedisCallParticipantRegistry,
    voiceLockService: voiceLockService as unknown as RedisVoiceLockService,
    tokenIssuer: issuer,
    voiceServicePublicUrl: 'http://voice.example.test',
  });

  return { broadcaster, callRegistry, voiceLockService, controller };
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
      workspaceId: 'client-workspace-id',
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
    workspaceId: 'untrusted-workspace-id',
    clientRequestId: 'request-1',
    mode: 'rag' as const,
  };

  await controller.start({ socket: ownerSocket, userId: 'user-1', userName: 'User One', payload: startPayload });

  const accepted = ownerSocket.events.find(({ event }) => event === 'voice:turn:accepted');
  assert.ok(accepted);
  assert.match(accepted.payload.uploadUrl, /\/v1\/voice\/turns\/.+\/audio$/);
  assert.match(accepted.payload.streamUrl, /\/v1\/voice\/turns\/.+\/stream$/);
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
