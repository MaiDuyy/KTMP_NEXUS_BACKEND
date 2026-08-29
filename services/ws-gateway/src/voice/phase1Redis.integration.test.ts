import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import type { VoicePipelineEvent } from '@ott/shared';
import {
  getCallMetaKey,
  getCallParticipantsKey,
  RedisCallParticipantRegistry,
} from '../calls/callRegistry.js';
import { VoiceTurnTokenIssuer } from './turnTokenService.js';
import { getVoiceLockKey, RedisVoiceLockService } from './voiceLockService.js';
import { RedisVoiceSessionStore } from './voiceSessionStore.js';
import {
  VoiceTurnController,
  type VoiceRoomBroadcaster,
  type VoiceSocket,
} from './voiceTurnController.js';

class IntegrationSocket implements VoiceSocket {
  public readonly events: Array<{ event: string; payload: any }> = [];
  public readonly rooms = new Set<string>();

  public emit(event: string, payload: unknown): boolean {
    this.events.push({ event, payload });
    return true;
  }

  public join(room: string): void {
    this.rooms.add(room);
  }

  public last(event: string): any {
    return this.events.findLast((entry) => entry.event === event)?.payload;
  }

  public clear(): void {
    this.events.length = 0;
  }
}

class IntegrationBroadcaster implements VoiceRoomBroadcaster {
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

const redisUrl = process.env.VOICE_INTEGRATION_REDIS_URL;

test('serializes two users through a real Redis voice lifecycle', {
  skip: redisUrl ? false : 'VOICE_INTEGRATION_REDIS_URL is not configured',
  timeout: 30_000,
}, async () => {
  const redis = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const meetingSessionId = 'p1-11-' + randomUUID();
  const chatId = 'chat-' + randomUUID();
  const workspaceId = 'workspace-' + randomUUID();
  const userOne = { id: 'p1-11-user-1', name: 'User One', socket: new IntegrationSocket() };
  const userTwo = { id: 'p1-11-user-2', name: 'User Two', socket: new IntegrationSocket() };
  const registry = new RedisCallParticipantRegistry(redis, 60);
  const lock = new RedisVoiceLockService(redis, 60);
  const sessions = new RedisVoiceSessionStore(redis, 60, 20);
  const broadcaster = new IntegrationBroadcaster();
  const controller = new VoiceTurnController({
    broadcaster,
    callRegistry: registry,
    voiceLockService: lock,
    voiceSessionStore: sessions,
    tokenIssuer: new VoiceTurnTokenIssuer({
      secret: 'p1-11-integration-secret-with-at-least-32-characters',
      ttlSeconds: 60,
    }),
    voicePublicApiUrl: 'http://gateway.integration.test/api',
  });
  const voicePrefix = 'voice:' + meetingSessionId;
  const redisKeys = [
    getCallMetaKey(meetingSessionId),
    getCallParticipantsKey(meetingSessionId),
    getVoiceLockKey(meetingSessionId),
    voicePrefix + ':session',
    voicePrefix + ':history',
    voicePrefix + ':history:dedupe',
  ];
  const startPayload = (clientRequestId: string) => ({
    meetingSessionId,
    chatId,
    workspaceId,
    clientRequestId,
    mode: 'rag' as const,
  });
  const start = (user: typeof userOne, requestId: string) => controller.start({
    socket: user.socket,
    userId: user.id,
    userName: user.name,
    payload: startPayload(requestId),
  });
  const assertLocked = async (user: typeof userOne, requestId: string): Promise<void> => {
    user.socket.clear();
    await start(user, requestId);
    assert.equal(user.socket.last('voice:error')?.code, 'VOICE_LOCKED_BY_OTHER');
  };

  try {
    await redis.connect();
    await registry.setMeta({
      meetingSessionId,
      roomName: meetingSessionId,
      chatId,
      workspaceId,
      status: 'active',
      updatedAt: new Date().toISOString(),
    });
    await Promise.all([
      registry.addParticipant(meetingSessionId, userOne.id),
      registry.addParticipant(meetingSessionId, userTwo.id),
    ]);

    await Promise.all([
      start(userOne, 'race-user-1'),
      start(userTwo, 'race-user-2'),
    ]);

    const acceptedUsers = [userOne, userTwo].filter((user) => user.socket.last('voice:turn:accepted'));
    const lockedUsers = [userOne, userTwo].filter(
      (user) => user.socket.last('voice:error')?.code === 'VOICE_LOCKED_BY_OTHER',
    );
    assert.equal(acceptedUsers.length, 1);
    assert.equal(lockedUsers.length, 1);

    const owner = acceptedUsers[0];
    const contender = lockedUsers[0];
    const accepted = owner.socket.last('voice:turn:accepted');
    const base = {
      meetingSessionId,
      turnId: accepted.turnId as string,
      ownerUserId: owner.id,
    };
    assert.deepEqual(await lock.get(meetingSessionId), {
      turnId: base.turnId,
      ownerUserId: owner.id,
    });
    assert.equal((await sessions.getActive(meetingSessionId))?.ownerUserId, owner.id);

    await controller.end({
      socket: owner.socket,
      userId: owner.id,
      userName: owner.name,
      payload: { meetingSessionId, turnId: base.turnId },
    });
    await assertLocked(contender, 'retry-finalizing');

    assert.equal(await controller.handlePipelineEvent({
      ...base,
      kind: 'state',
      state: 'THINKING',
    }), true);
    await assertLocked(contender, 'retry-thinking');

    const transcript: VoicePipelineEvent = {
      ...base,
      kind: 'transcript',
      speakerName: owner.name,
      text: 'Synthetic integration question',
      confidence: 0.99,
    };
    const message: VoicePipelineEvent = {
      ...base,
      kind: 'message',
      displayText: 'Synthetic integration answer',
      sources: [],
    };
    assert.equal(await controller.handlePipelineEvent(transcript), true);
    assert.equal(await controller.handlePipelineEvent(transcript), true);
    assert.equal(await controller.handlePipelineEvent(message), true);
    assert.equal(await controller.handlePipelineEvent(message), true);
    assert.equal(await controller.handlePipelineEvent({
      ...base,
      kind: 'state',
      state: 'RESPONDING',
    }), true);
    await assertLocked(contender, 'retry-responding');

    const [ownerSync, contenderSync] = await Promise.all([
      controller.sync({
        socket: owner.socket,
        userId: owner.id,
        userName: owner.name,
        payload: { meetingSessionId },
      }),
      controller.sync({
        socket: contender.socket,
        userId: contender.id,
        userName: contender.name,
        payload: { meetingSessionId },
      }),
    ]);
    assert.deepEqual(ownerSync, contenderSync);
    assert.equal(ownerSync?.activeTurn?.state, 'RESPONDING');
    assert.equal(ownerSync?.messages.length, 2);

    assert.equal(await controller.handlePipelineEvent({
      ...base,
      kind: 'terminal',
      state: 'COMPLETED',
    }), true);
    contender.socket.clear();
    await start(contender, 'after-ready');
    const nextAccepted = contender.socket.last('voice:turn:accepted');
    assert.ok(nextAccepted);

    assert.equal(await controller.handlePipelineEvent({
      ...base,
      kind: 'terminal',
      state: 'COMPLETED',
    }), false);
    assert.equal((await lock.get(meetingSessionId))?.turnId, nextAccepted.turnId);

    await controller.cancelForParticipantDeparture(meetingSessionId, owner.id);
    assert.equal((await lock.get(meetingSessionId))?.turnId, nextAccepted.turnId);
    await controller.cancelForParticipantDeparture(meetingSessionId, contender.id);
    assert.equal(await lock.get(meetingSessionId), null);

    await controller.cancelForCallCleanup(meetingSessionId);
    await registry.clear(meetingSessionId);
    assert.deepEqual(await redis.mget(
      getVoiceLockKey(meetingSessionId),
      voicePrefix + ':session',
      voicePrefix + ':history',
      voicePrefix + ':history:dedupe',
    ), [null, null, null, null]);
    assert.equal(await redis.exists(getCallMetaKey(meetingSessionId), getCallParticipantsKey(meetingSessionId)), 0);
  } finally {
    if (redis.status === 'ready' || redis.status === 'connect') {
      await redis.del(...redisKeys).catch(() => undefined);
    }
    redis.disconnect();
  }
});
