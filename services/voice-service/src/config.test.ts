import assert from "node:assert/strict";
import test from "node:test";
import { loadVoiceServiceConfig } from "./config.js";

test("uses safe defaults without provider credentials", () => {
  const config = loadVoiceServiceConfig({ NODE_ENV: "test" });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.meetingVoiceEnabled, true);
  assert.equal(config.voiceMetricsEnabled, true);
  assert.equal(config.voiceStreamingEnabled, false);
  assert.deepEqual([...config.voiceStreamAllowedOrigins], ['http://localhost:3000']);
  assert.equal(config.port, 3035);
  assert.equal(config.shutdownTimeoutMs, 10_000);
  assert.equal(config.logLevel, "info");
  assert.equal(config.redisUrl, "redis://localhost:6379");
  assert.equal(config.voiceTurnTokenSecret, null);
  assert.equal(config.googleCloudLocation, "asia-southeast1");
  assert.equal(config.googleSttLanguage, "vi-VN");
  assert.equal(config.googleSttModel, 'chirp_3');
  assert.equal(config.googleStreamingSttLocation, 'us');
  assert.equal(config.googleStreamingSttModel, 'chirp_3');
  assert.deepEqual(config.googleStreamingSttPhrases, []);
  assert.equal(config.meetingAiStreamFirstEventTimeoutMs, 10_000);
  assert.equal(config.meetingAiStreamIdleEventTimeoutMs, 20_000);

  assert.equal(config.livekitUrl, null);
  assert.equal(config.livekitApiKey, null);
  assert.equal(config.livekitApiSecret, null);
  assert.equal(config.livekitAiParticipantName, "Nexus AI");
  assert.equal(config.livekitConnectTimeoutMs, 15000);
  assert.equal(config.livekitPlayoutTimeoutMs, 70000);
});

test('feature and metrics flags default off in production and reject invalid values', () => {
  const production = loadVoiceServiceConfig({
    NODE_ENV: 'production',
    VOICE_TURN_TOKEN_SECRET: '12345678901234567890123456789012',
    VOICE_INTERNAL_SERVICE_KEY: '12345678901234567890123456789012',
    MEETING_AI_INTERNAL_SERVICE_KEY: '12345678901234567890123456789012',
    VOICE_CONTROL_INTERNAL_URL: 'http://voice-control.test',
    MEETING_AI_INTERNAL_URL: 'http://meeting-ai.test',
    LIVEKIT_URL: 'wss://livekit.test',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret',
  });
  assert.equal(production.meetingVoiceEnabled, false);
  assert.equal(production.voiceMetricsEnabled, false);
  assert.throws(
    () => loadVoiceServiceConfig({ MEETING_VOICE_ENABLED: 'yes' }),
    /MEETING_VOICE_ENABLED must be true, false, 1, or 0/,
  );
  assert.throws(
    () => loadVoiceServiceConfig({ MEETING_AI_STREAM_FIRST_EVENT_TIMEOUT_MS: '0' }),
    /MEETING_AI_STREAM_FIRST_EVENT_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () => loadVoiceServiceConfig({ VOICE_METRICS_ENABLED: 'yes' }),
    /VOICE_METRICS_ENABLED must be true, false, 1, or 0/,
  );
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
  assert.throws(
    () => loadVoiceServiceConfig({ VOICE_STREAM_MAX_DURATION_MS: '60001' }),
    /must be less than or equal to 60000/,
  );
});

test('normalizes and bounds configured streaming speech phrases', () => {
  const config = loadVoiceServiceConfig({
    NODE_ENV: 'test',
    GOOGLE_STREAMING_STT_PHRASES: ' Nexus ERP,  Công nghệ   thông tin ,nexus erp ',
  });
  assert.deepEqual(config.googleStreamingSttPhrases, ['Nexus ERP', 'Công nghệ thông tin']);
  assert.throws(
    () => loadVoiceServiceConfig({ GOOGLE_STREAMING_STT_PHRASES: 'x'.repeat(101) }),
    /larger than 100 bytes/,
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
