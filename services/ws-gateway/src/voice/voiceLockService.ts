import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const DEFAULT_VOICE_LOCK_TTL_SECONDS = 180;

export interface VoiceLockOwner {
  turnId: string;
  ownerUserId: string;
}

export interface VoiceLockHandle extends VoiceLockOwner {
  meetingSessionId: string;
  token: string;
  lockValue: string;
}

export function getVoiceLockKey(meetingSessionId: string): string {
  return `voice:${assertIdentifier(meetingSessionId, 'meetingSessionId')}:lock`;
}

const RELEASE_LOCK_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

const REFRESH_LOCK_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], ARGV[2])
  end
  return 0
`;

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

function isRedisSuccessResult(result: unknown): boolean {
  return result === 1 || result === '1';
}

interface StoredVoiceLock extends VoiceLockOwner {
  token: string;
}

function parseStoredLock(raw: string): StoredVoiceLock {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as StoredVoiceLock).turnId !== 'string' ||
      typeof (value as StoredVoiceLock).ownerUserId !== 'string' ||
      typeof (value as StoredVoiceLock).token !== 'string'
    ) {
      throw new Error('invalid shape');
    }

    return value as StoredVoiceLock;
  } catch {
    throw new Error('Stored voice lock value is invalid');
  }
}

function assertHandle(handle: VoiceLockHandle): void {
  assertIdentifier(handle.meetingSessionId, 'meetingSessionId');
  assertIdentifier(handle.turnId, 'turnId');
  assertIdentifier(handle.ownerUserId, 'ownerUserId');
  assertIdentifier(handle.token, 'token');
  assertIdentifier(handle.lockValue, 'lockValue');
}

/** Atomic, token-owned lock that serializes voice turns per meeting session. */
export class RedisVoiceLockService {
  private readonly ttlSeconds: number;

  public constructor(
    private readonly redis: Redis,
    ttlSeconds: number = DEFAULT_VOICE_LOCK_TTL_SECONDS,
  ) {
    this.ttlSeconds = assertTtl(ttlSeconds);
  }

  public async acquire(
    meetingSessionId: string,
    turnId: string,
    ownerUserId: string,
    ttlSeconds: number = this.ttlSeconds,
  ): Promise<VoiceLockHandle | null> {
    assertIdentifier(turnId, 'turnId');
    assertIdentifier(ownerUserId, 'ownerUserId');
    const ttl = assertTtl(ttlSeconds);
    const token = randomUUID();
    const lockValue = JSON.stringify({ turnId, ownerUserId, token });
    const handle: VoiceLockHandle = {
      meetingSessionId: assertIdentifier(meetingSessionId, 'meetingSessionId'),
      turnId,
      ownerUserId,
      token,
      lockValue,
    };
    const result = await this.redis.set(
      getVoiceLockKey(meetingSessionId),
      lockValue,
      'EX',
      ttl,
      'NX',
    );

    return result === 'OK' ? handle : null;
  }

  public async get(meetingSessionId: string): Promise<VoiceLockOwner | null> {
    const raw = await this.redis.get(getVoiceLockKey(meetingSessionId));
    if (raw === null) {
      return null;
    }

    const lock = parseStoredLock(raw);
    return { turnId: lock.turnId, ownerUserId: lock.ownerUserId };
  }

  public async isOwner(handle: VoiceLockHandle): Promise<boolean> {
    assertHandle(handle);
    const raw = await this.redis.get(getVoiceLockKey(handle.meetingSessionId));
    return raw !== null && raw === handle.lockValue;
  }

  public async refresh(
    handle: VoiceLockHandle,
    ttlSeconds: number = this.ttlSeconds,
  ): Promise<boolean> {
    assertHandle(handle);
    assertTtl(ttlSeconds);
    const result = await this.redis.eval(
      REFRESH_LOCK_SCRIPT,
      1,
      getVoiceLockKey(handle.meetingSessionId),
      handle.lockValue,
      ttlSeconds,
    );
    return isRedisSuccessResult(result);
  }

  public async release(handle: VoiceLockHandle): Promise<boolean> {
    assertHandle(handle);
    const result = await this.redis.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      getVoiceLockKey(handle.meetingSessionId),
      handle.lockValue,
    );
    return isRedisSuccessResult(result);
  }
}
