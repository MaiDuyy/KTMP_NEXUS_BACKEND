import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const VOICE_TURN_TOKEN_AUDIENCE = 'voice-service';
export const VOICE_TURN_TOKEN_ISSUER = 'ws-gateway';
export const DEFAULT_VOICE_TURN_TOKEN_TTL_SECONDS = 120;
export const MAX_VOICE_TURN_TOKEN_TTL_SECONDS = 120;

export interface VoiceTurnTokenConfig {
  secret: string;
  ttlSeconds?: number;
}

export interface VoiceTurnTokenInput {
  userId: string;
  meetingSessionId: string;
  turnId: string;
  chatId: string;
}

export interface IssuedVoiceTurnToken {
  token: string;
  expiresAt: string;
}

function assertSecret(value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 32) {
    throw new Error('VOICE_TURN_TOKEN_SECRET must contain at least 32 non-whitespace characters');
  }

  return value;
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

function resolveTtlSeconds(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_VOICE_TURN_TOKEN_TTL_SECONDS;
  }

  if (!Number.isInteger(value) || value <= 0 || value > MAX_VOICE_TURN_TOKEN_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be an integer from 1 to ${MAX_VOICE_TURN_TOKEN_TTL_SECONDS}`);
  }

  return value;
}

/** Issues short-lived credentials that Voice Service verifies before accepting audio. */
export class VoiceTurnTokenIssuer {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  public constructor(config: VoiceTurnTokenConfig) {
    this.secret = assertSecret(config.secret);
    this.ttlSeconds = resolveTtlSeconds(config.ttlSeconds);
  }

  public issue(input: VoiceTurnTokenInput, now: Date = new Date()): IssuedVoiceTurnToken {
    const issuedAtSeconds = Math.floor(now.getTime() / 1_000);
    const expiresAt = new Date((issuedAtSeconds + this.ttlSeconds) * 1_000);
    const token = jwt.sign(
      {
        meetingSessionId: assertIdentifier(input.meetingSessionId, 'meetingSessionId'),
        turnId: assertIdentifier(input.turnId, 'turnId'),
        chatId: assertIdentifier(input.chatId, 'chatId'),
        jti: randomUUID(),
      },
      this.secret,
      {
        algorithm: 'HS256',
        audience: VOICE_TURN_TOKEN_AUDIENCE,
        expiresIn: this.ttlSeconds,
        issuer: VOICE_TURN_TOKEN_ISSUER,
        subject: assertIdentifier(input.userId, 'userId'),
      },
    );

    return { token, expiresAt: expiresAt.toISOString() };
  }
}

export function getVoiceTurnTokenTtlSeconds(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.VOICE_TURN_TOKEN_TTL_SECONDS;
  if (raw === undefined || raw === '') {
    return DEFAULT_VOICE_TURN_TOKEN_TTL_SECONDS;
  }

  return resolveTtlSeconds(Number(raw));
}
