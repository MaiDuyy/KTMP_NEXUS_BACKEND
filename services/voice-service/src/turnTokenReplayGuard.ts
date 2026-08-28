import type { Redis } from "ioredis";

const TURN_TOKEN_REPLAY_KEY_PREFIX = "voice:turn-token:jti:";

export interface TurnTokenReplayGuard {
  consume(jti: string, expiresAtSeconds: number, nowSeconds?: number): Promise<boolean>;
}

function assertJti(jti: string): string {
  if (
    typeof jti !== "string" ||
    jti.length === 0 ||
    jti.length > 256 ||
    jti.trim() !== jti ||
    /[\u0000-\u001f\u007f]/.test(jti)
  ) {
    throw new Error("jti must be a non-empty identifier");
  }

  return jti;
}

function getRemainingLifetime(expiresAtSeconds: number, nowSeconds: number): number {
  if (!Number.isInteger(expiresAtSeconds) || !Number.isInteger(nowSeconds)) {
    throw new Error("token expiry timestamps must be integers");
  }

  const remainingLifetime = expiresAtSeconds - nowSeconds;
  if (remainingLifetime <= 0) {
    throw new Error("turn token has expired");
  }

  return remainingLifetime;
}

export function getTurnTokenReplayKey(jti: string): string {
  return `${TURN_TOKEN_REPLAY_KEY_PREFIX}${assertJti(jti)}`;
}

/** Atomic multi-instance replay protection for a verified turn token. */
export class RedisTurnTokenReplayGuard implements TurnTokenReplayGuard {
  public constructor(private readonly redis: Redis) {}

  public async consume(
    jti: string,
    expiresAtSeconds: number,
    nowSeconds: number = Math.floor(Date.now() / 1_000),
  ): Promise<boolean> {
    const ttlSeconds = getRemainingLifetime(expiresAtSeconds, nowSeconds);
    const result = await this.redis.set(getTurnTokenReplayKey(jti), "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }
}
