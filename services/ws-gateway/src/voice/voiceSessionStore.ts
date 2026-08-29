import type { Redis } from 'ioredis';
import type { VoiceActiveTurn, VoiceHistoryMessage, VoiceTurnState } from '@ott/shared';

const DEFAULT_SESSION_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_HISTORY_LIMIT = 100;

const UPDATE_STATE_SCRIPT = `
  if redis.call('hget', KEYS[1], 'turnId') ~= ARGV[1]
    or redis.call('hget', KEYS[1], 'ownerUserId') ~= ARGV[2] then
    return 0
  end
  redis.call('hset', KEYS[1], 'state', ARGV[3], 'updatedAt', ARGV[4])
  redis.call('expire', KEYS[1], ARGV[5])
  return 1
`;

const APPEND_HISTORY_SCRIPT = `
  if redis.call('hget', KEYS[1], 'turnId') ~= ARGV[1]
    or redis.call('hget', KEYS[1], 'ownerUserId') ~= ARGV[2] then
    return 0
  end
  if redis.call('set', KEYS[3], '1', 'EX', ARGV[5], 'NX') == false then
    return 1
  end
  redis.call('rpush', KEYS[2], ARGV[3])
  redis.call('ltrim', KEYS[2], -tonumber(ARGV[4]), -1)
  redis.call('expire', KEYS[2], ARGV[5])
  return 1
`;

const CLEAR_ACTIVE_SCRIPT = `
  if redis.call('hget', KEYS[1], 'turnId') ~= ARGV[1]
    or redis.call('hget', KEYS[1], 'ownerUserId') ~= ARGV[2] then
    return 0
  end
  return redis.call('del', KEYS[1])
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

function isSuccess(value: unknown): boolean {
  return value === 1 || value === '1';
}

function snapshotKey(meetingSessionId: string): string {
  return `voice:${assertIdentifier(meetingSessionId, 'meetingSessionId')}:session`;
}

function historyKey(meetingSessionId: string): string {
  return `voice:${assertIdentifier(meetingSessionId, 'meetingSessionId')}:history`;
}

function historyDedupeKey(meetingSessionId: string, messageId: string): string {
  return `voice:${assertIdentifier(meetingSessionId, 'meetingSessionId')}:history:${assertIdentifier(messageId, 'messageId')}`;
}

export interface VoiceSessionStore {
  activate(meetingSessionId: string, activeTurn: VoiceActiveTurn): Promise<void>;
  updateState(
    meetingSessionId: string,
    turnId: string,
    ownerUserId: string,
    state: VoiceTurnState,
  ): Promise<boolean>;
  appendHistory(
    meetingSessionId: string,
    turnId: string,
    ownerUserId: string,
    message: VoiceHistoryMessage,
  ): Promise<boolean>;
  clearActive(meetingSessionId: string, turnId: string, ownerUserId: string): Promise<boolean>;
  getActive(meetingSessionId: string): Promise<VoiceActiveTurn | null>;
  getHistory(meetingSessionId: string): Promise<VoiceHistoryMessage[]>;
  clearSession(meetingSessionId: string): Promise<void>;
}

export class RedisVoiceSessionStore implements VoiceSessionStore {
  public constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
    private readonly historyLimit: number = DEFAULT_HISTORY_LIMIT,
  ) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('ttlSeconds must be a positive integer');
    }
    if (!Number.isInteger(historyLimit) || historyLimit <= 0) {
      throw new Error('historyLimit must be a positive integer');
    }
  }

  public async activate(meetingSessionId: string, activeTurn: VoiceActiveTurn): Promise<void> {
    assertIdentifier(activeTurn.turnId, 'turnId');
    assertIdentifier(activeTurn.ownerUserId, 'ownerUserId');
    if (!activeTurn.ownerName || activeTurn.ownerName.length > 256) {
      throw new Error('ownerName must be non-empty and at most 256 characters');
    }
    const key = snapshotKey(meetingSessionId);
    await this.redis.multi()
      .hset(key, {
        turnId: activeTurn.turnId,
        ownerUserId: activeTurn.ownerUserId,
        ownerName: activeTurn.ownerName,
        state: activeTurn.state,
        updatedAt: new Date().toISOString(),
      })
      .expire(key, this.ttlSeconds)
      .exec();
  }

  public async updateState(
    meetingSessionId: string,
    turnId: string,
    ownerUserId: string,
    state: VoiceTurnState,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      UPDATE_STATE_SCRIPT,
      1,
      snapshotKey(meetingSessionId),
      assertIdentifier(turnId, 'turnId'),
      assertIdentifier(ownerUserId, 'ownerUserId'),
      state,
      new Date().toISOString(),
      this.ttlSeconds,
    );
    return isSuccess(result);
  }

  public async appendHistory(
    meetingSessionId: string,
    turnId: string,
    ownerUserId: string,
    message: VoiceHistoryMessage,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      APPEND_HISTORY_SCRIPT,
      3,
      snapshotKey(meetingSessionId),
      historyKey(meetingSessionId),
      historyDedupeKey(meetingSessionId, message.id),
      assertIdentifier(turnId, 'turnId'),
      assertIdentifier(ownerUserId, 'ownerUserId'),
      JSON.stringify(message),
      this.historyLimit,
      this.ttlSeconds,
    );
    return isSuccess(result);
  }

  public async clearActive(meetingSessionId: string, turnId: string, ownerUserId: string): Promise<boolean> {
    const result = await this.redis.eval(
      CLEAR_ACTIVE_SCRIPT,
      1,
      snapshotKey(meetingSessionId),
      assertIdentifier(turnId, 'turnId'),
      assertIdentifier(ownerUserId, 'ownerUserId'),
    );
    return isSuccess(result);
  }

  public async getActive(meetingSessionId: string): Promise<VoiceActiveTurn | null> {
    const value = await this.redis.hgetall(snapshotKey(meetingSessionId));
    if (!value.turnId || !value.ownerUserId || !value.ownerName || !value.state) {
      return null;
    }
    return {
      turnId: value.turnId,
      ownerUserId: value.ownerUserId,
      ownerName: value.ownerName,
      state: value.state as VoiceTurnState,
    };
  }

  public async getHistory(meetingSessionId: string): Promise<VoiceHistoryMessage[]> {
    const values = await this.redis.lrange(historyKey(meetingSessionId), 0, -1);
    return values.flatMap((raw) => {
      try {
        return [JSON.parse(raw) as VoiceHistoryMessage];
      } catch {
        return [];
      }
    });
  }

  public async clearSession(meetingSessionId: string): Promise<void> {
    await this.redis.del(snapshotKey(meetingSessionId), historyKey(meetingSessionId));
  }
}
