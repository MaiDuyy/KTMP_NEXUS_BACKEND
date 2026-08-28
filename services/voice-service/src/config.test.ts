import assert from "node:assert/strict";
import test from "node:test";
import { loadVoiceServiceConfig } from "./config.js";

test("uses safe defaults without provider credentials", () => {
  const config = loadVoiceServiceConfig({ NODE_ENV: "test" });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 3035);
  assert.equal(config.shutdownTimeoutMs, 10_000);
  assert.equal(config.logLevel, "info");
});

test("rejects invalid numeric configuration", () => {
  assert.throws(
    () => loadVoiceServiceConfig({ VOICE_SERVICE_PORT: "3035.5" }),
    /VOICE_SERVICE_PORT must be a positive integer/,
  );
});

test("uses service-specific port before generic PORT", () => {
  const config = loadVoiceServiceConfig({ VOICE_SERVICE_PORT: "3040", PORT: "3041" });
  assert.equal(config.port, 3040);
});
