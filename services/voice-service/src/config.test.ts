import assert from "node:assert/strict";
import test from "node:test";
import { loadVoiceServiceConfig } from "./config.js";

test("uses safe defaults without provider credentials", () => {
  const config = loadVoiceServiceConfig({ NODE_ENV: "test" });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 3035);
  assert.equal(config.shutdownTimeoutMs, 10_000);
  assert.equal(config.logLevel, "info");
  assert.equal(config.redisUrl, "redis://localhost:6379");
  assert.equal(config.voiceTurnTokenSecret, null);
  assert.equal(config.googleCloudLocation, "asia-southeast1");
  assert.equal(config.googleSttLanguage, "vi-VN");

  assert.equal(config.livekitUrl, null);
  assert.equal(config.livekitApiKey, null);
  assert.equal(config.livekitApiSecret, null);
  assert.equal(config.livekitAiParticipantName, "Nexus AI");
  assert.equal(config.livekitConnectTimeoutMs, 15000);
  assert.equal(config.livekitPlayoutTimeoutMs, 70000);
});

test("rejects invalid numeric configuration", () => {
  assert.throws(
    () => loadVoiceServiceConfig({ VOICE_SERVICE_PORT: "3035.5" }),
    /VOICE_SERVICE_PORT must be a positive integer/,
  );
  assert.throws(
    () => loadVoiceServiceConfig({ LIVEKIT_CONNECT_TIMEOUT_MS: "invalid" }),
    /LIVEKIT_CONNECT_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () => loadVoiceServiceConfig({ LIVEKIT_PLAYOUT_TIMEOUT_MS: "0" }),
    /LIVEKIT_PLAYOUT_TIMEOUT_MS must be a positive integer/,
  );
});

test("uses service-specific port before generic PORT", () => {
  const config = loadVoiceServiceConfig({ VOICE_SERVICE_PORT: "3040", PORT: "3041" });
  assert.equal(config.port, 3040);
});

test("requires a strong turn token secret in production", () => {
  assert.throws(
    () => loadVoiceServiceConfig({ NODE_ENV: "production", LIVEKIT_URL: "ws://test", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }),
    /VOICE_TURN_TOKEN_SECRET is required in production/,
  );
  assert.throws(
    () => loadVoiceServiceConfig({ NODE_ENV: "production", VOICE_TURN_TOKEN_SECRET: "too-short", LIVEKIT_URL: "ws://test", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }),
    /at least 32/,
  );
});

test("LiveKit credentials rules", () => {
  // Missing all three is allowed in test/dev
  assert.doesNotThrow(() => loadVoiceServiceConfig({ NODE_ENV: "test" }));

  // Missing all three is rejected in production
  assert.throws(
    () => loadVoiceServiceConfig({ NODE_ENV: "production", VOICE_TURN_TOKEN_SECRET: "12345678901234567890123456789012" }),
    /LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required in production/
  );

  // Partial missing
  assert.throws(
    () => loadVoiceServiceConfig({ LIVEKIT_URL: "ws://test" }),
    /LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must all be provided together/
  );

  // Invalid URL scheme
  assert.throws(
    () => loadVoiceServiceConfig({ LIVEKIT_URL: "http://test", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }),
    /LIVEKIT_URL must start with ws:\/\/ or wss:\/\//
  );

  // Valid credentials
  const config = loadVoiceServiceConfig({ LIVEKIT_URL: "wss://test", LIVEKIT_API_KEY: "key", LIVEKIT_API_SECRET: "sec" });
  assert.equal(config.livekitUrl, "wss://test");
  assert.equal(config.livekitApiKey, "key");
  assert.equal(config.livekitApiSecret, "sec");
});
