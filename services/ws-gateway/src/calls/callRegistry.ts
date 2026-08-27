import type { Redis } from 'ioredis';

export const DEFAULT_CALL_SESSION_TTL_SECONDS = 7_200;

export type CallRegistryStatus = 'active' | 'ending' | 'ended';

export interface CallRegistryMeta {
  meetingSessionId: string;
  roomName: string;
  chatId: string;
  workspaceId?: string;
  status: CallRegistryStatus;
  updatedAt: string;
}

export function getCallMetaKey(meetingSessionId: string): string {
  return `call:${assertIdentifier(meetingSessionId, 'meetingSessionId')}:meta`;
}

export function getCallParticipantsKey(meetingSessionId: string): string {
  return `call:${assertIdentifier(meetingSessionId, 'meetingSessionId')}:participants`;
}

function assertIdentifier(value: string, fieldName: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${fieldName} must be a non-empty identifier`);
  }

  return value;
}

function assertTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive integer');
  }

  return ttlSeconds;
}

function isCallRegistryStatus(value: string | undefined): value is CallRegistryStatus {
  return value === 'active' || value === 'ending' || value === 'ended';
}

/** Redis-backed metadata and participant membership for one call session. */
export class RedisCallParticipantRegistry {
  private readonly ttlSeconds: number;

  public constructor(
    private readonly redis: Redis,
    ttlSeconds: number = DEFAULT_CALL_SESSION_TTL_SECONDS,
  ) {
    this.ttlSeconds = assertTtl(ttlSeconds);
  }

  public async setMeta(meta: CallRegistryMeta): Promise<void> {
    assertIdentifier(meta.meetingSessionId, 'meetingSessionId');
    assertIdentifier(meta.roomName, 'roomName');
    assertIdentifier(meta.chatId, 'chatId');
    if (meta.workspaceId !== undefined) {
      assertIdentifier(meta.workspaceId, 'workspaceId');
    }
    if (!isCallRegistryStatus(meta.status)) {
      throw new Error('status must be a valid call registry status');
    }
    assertIdentifier(meta.updatedAt, 'updatedAt');

    const key = getCallMetaKey(meta.meetingSessionId);
    const fields: Record<string, string> = {
      meetingSessionId: meta.meetingSessionId,
      roomName: meta.roomName,
      chatId: meta.chatId,
      status: meta.status,
      updatedAt: meta.updatedAt,
    };

    const transaction = this.redis.multi().hset(key, fields).expire(key, this.ttlSeconds);
    if (meta.workspaceId !== undefined) {
      transaction.hset(key, 'workspaceId', meta.workspaceId);
    } else {
      transaction.hdel(key, 'workspaceId');
    }

    await transaction.exec();
  }

  public async getMeta(meetingSessionId: string): Promise<CallRegistryMeta | null> {
    const key = getCallMetaKey(meetingSessionId);
    const fields = await this.redis.hgetall(key);

    if (Object.keys(fields).length === 0) {
      return null;
    }

    if (
      !fields.meetingSessionId ||
      !fields.roomName ||
      !fields.chatId ||
      !isCallRegistryStatus(fields.status) ||
      !fields.updatedAt
    ) {
      throw new Error('Stored call metadata is invalid');
    }

    return {
      meetingSessionId: fields.meetingSessionId,
      roomName: fields.roomName,
      chatId: fields.chatId,
      ...(fields.workspaceId ? { workspaceId: fields.workspaceId } : {}),
      status: fields.status,
      updatedAt: fields.updatedAt,
    };
  }

  public async addParticipant(meetingSessionId: string, userId: string): Promise<void> {
    assertIdentifier(userId, 'userId');
    const key = getCallParticipantsKey(meetingSessionId);
    await this.redis.multi().sadd(key, userId).expire(key, this.ttlSeconds).exec();
  }

  public async removeParticipant(meetingSessionId: string, userId: string): Promise<void> {
    assertIdentifier(userId, 'userId');
    await this.redis.srem(getCallParticipantsKey(meetingSessionId), userId);
  }

  public async hasParticipant(meetingSessionId: string, userId: string): Promise<boolean> {
    assertIdentifier(userId, 'userId');
    return (await this.redis.sismember(getCallParticipantsKey(meetingSessionId), userId)) === 1;
  }

  public async getParticipantIds(meetingSessionId: string): Promise<string[]> {
    return this.redis.smembers(getCallParticipantsKey(meetingSessionId));
  }

  public async getParticipantCount(meetingSessionId: string): Promise<number> {
    return this.redis.scard(getCallParticipantsKey(meetingSessionId));
  }

  public async clear(meetingSessionId: string): Promise<void> {
    await this.redis.del(getCallMetaKey(meetingSessionId), getCallParticipantsKey(meetingSessionId));
  }
}
