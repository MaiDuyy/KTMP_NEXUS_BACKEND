import jwt from "jsonwebtoken";
import type { TurnTokenReplayGuard } from "./turnTokenReplayGuard.js";

export const VOICE_TURN_TOKEN_AUDIENCE = "voice-service";
export const VOICE_TURN_TOKEN_ISSUER = "ws-gateway";

export interface VerifiedVoiceTurnToken {
  userId: string;
  jti: string;
  meetingSessionId: string;
  turnId: string;
  chatId: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
}

export interface VoiceTurnTokenVerifierConfig {
  secret: string;
  replayGuard: TurnTokenReplayGuard;
}

function assertIdentifier(value: unknown, fieldName: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${fieldName} must be a non-empty identifier`);
  }

  return value;
}

function assertTimestamp(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${fieldName} must be a positive integer timestamp`);
  }

  return value as number;
}

function assertSecret(secret: string): string {
  if (typeof secret !== "string" || secret.trim() !== secret || secret.length < 32) {
    throw new Error("VOICE_TURN_TOKEN_SECRET must contain at least 32 non-whitespace characters");
  }

  return secret;
}

/** Verifies the immutable user/meeting/turn binding before audio is accepted. */
export class VoiceTurnTokenVerifier {
  private readonly secret: string;
  private readonly replayGuard: TurnTokenReplayGuard;

  public constructor(config: VoiceTurnTokenVerifierConfig) {
    this.secret = assertSecret(config.secret);
    this.replayGuard = config.replayGuard;
  }

  public verify(token: string, nowSeconds: number = Math.floor(Date.now() / 1_000)): VerifiedVoiceTurnToken {
    if (typeof token !== "string" || token.length === 0 || token.length > 8_192) {
      throw new Error("turn token must be a non-empty JWT");
    }

    const payload = jwt.verify(token, this.secret, {
      algorithms: ["HS256"],
      audience: VOICE_TURN_TOKEN_AUDIENCE,
      clockTimestamp: nowSeconds,
      issuer: VOICE_TURN_TOKEN_ISSUER,
    });
    if (typeof payload === "string") {
      throw new Error("turn token payload must be an object");
    }

    return {
      userId: assertIdentifier(payload.sub, "sub"),
      jti: assertIdentifier(payload.jti, "jti"),
      meetingSessionId: assertIdentifier(payload.meetingSessionId, "meetingSessionId"),
      turnId: assertIdentifier(payload.turnId, "turnId"),
      chatId: assertIdentifier(payload.chatId, "chatId"),
      issuedAtSeconds: assertTimestamp(payload.iat, "iat"),
      expiresAtSeconds: assertTimestamp(payload.exp, "exp"),
    };
  }

  public async verifyAndConsume(
    token: string,
    nowSeconds: number = Math.floor(Date.now() / 1_000),
  ): Promise<VerifiedVoiceTurnToken> {
    const verified = this.verify(token, nowSeconds);
    const consumed = await this.replayGuard.consume(verified.jti, verified.expiresAtSeconds, nowSeconds);
    if (!consumed) {
      throw new Error("turn token has already been used");
    }

    return verified;
  }
}
