import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import type { TurnTokenReplayGuard } from "./turnTokenReplayGuard.js";
import { VoiceTurnTokenVerifier } from "./turnTokenVerifier.js";

const SECRET = "test-voice-turn-secret-with-sufficient-length";
const NOW_SECONDS = 1_788_000_000;

class FakeReplayGuard implements TurnTokenReplayGuard {
  private readonly used = new Set<string>();

  public async consume(jti: string): Promise<boolean> {
    if (this.used.has(jti)) {
      return false;
    }

    this.used.add(jti);
    return true;
  }
}

function signToken(
  overrides: Record<string, unknown> = {},
  options: jwt.SignOptions = {},
): string {
  return jwt.sign(
    {
      jti: "turn-jti-1",
      meetingSessionId: "call-1",
      turnId: "turn-1",
      chatId: "chat-1",
      iat: NOW_SECONDS,
      ...overrides,
    },
    SECRET,
    {
      algorithm: "HS256",
      audience: "voice-service",
      expiresIn: 60,
      issuer: "ws-gateway",
      subject: "user-1",
      ...options,
    },
  );
}

test("verifies a Gateway turn token with immutable user and call claims", () => {
  const verifier = new VoiceTurnTokenVerifier({ secret: SECRET, replayGuard: new FakeReplayGuard() });

  const verified = verifier.verify(signToken(), NOW_SECONDS + 1);

  assert.deepEqual(verified, {
    userId: "user-1",
    jti: "turn-jti-1",
    meetingSessionId: "call-1",
    turnId: "turn-1",
    chatId: "chat-1",
    issuedAtSeconds: NOW_SECONDS,
    expiresAtSeconds: NOW_SECONDS + 60,
  });
});

test("rejects bad signature, issuer, audience, expiry, and incomplete claims", () => {
  const verifier = new VoiceTurnTokenVerifier({ secret: SECRET, replayGuard: new FakeReplayGuard() });
  const wrongSignature = jwt.sign({}, "different-secret-with-sufficient-length", {
    algorithm: "HS256",
    audience: "voice-service",
    expiresIn: 60,
    issuer: "ws-gateway",
    subject: "user-1",
  });

  assert.throws(() => verifier.verify(wrongSignature, NOW_SECONDS), /invalid signature/);
  assert.throws(() => verifier.verify(signToken({}, { issuer: "other-service" }), NOW_SECONDS), /jwt issuer invalid/);
  assert.throws(() => verifier.verify(signToken({}, { audience: "other-service" }), NOW_SECONDS), /jwt audience invalid/);
  assert.throws(() => verifier.verify(signToken({}, { expiresIn: 1 }), NOW_SECONDS + 2), /jwt expired/);
  assert.throws(() => verifier.verify(signToken({ chatId: "" }), NOW_SECONDS), /chatId must be a non-empty identifier/);
});

test("consumes a jti once to block replay across Voice Service instances", async () => {
  const replayGuard = new FakeReplayGuard();
  const verifier = new VoiceTurnTokenVerifier({ secret: SECRET, replayGuard });
  const token = signToken();

  await verifier.verifyAndConsume(token, NOW_SECONDS + 1);
  await assert.rejects(() => verifier.verifyAndConsume(token, NOW_SECONDS + 1), /already been used/);
});
