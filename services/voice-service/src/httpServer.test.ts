import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { createVoiceHttpServer } from "./httpServer.js";
import type { VoiceServiceLogger } from "./logger.js";
import type { VoiceTurnTokenVerifier } from "./turnTokenVerifier.js";

const logger: VoiceServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

async function withServer(
  isReady: () => boolean,
  callback: (baseUrl: string, port: number) => Promise<void>,
  options: Parameters<typeof createVoiceHttpServer>[0] = { logger },
): Promise<void> {
  const server = createVoiceHttpServer({ ...options, logger, isReady });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    await callback(`http://127.0.0.1:${address.port}`, address.port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("returns health without configuration details", async () => {
  await withServer(() => true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "voice-service" });
  });
});

test("accepts bounded audio only after the turn token is consumed", async () => {
  const uploads: unknown[] = [];
  const verifier = {
    verifyAndConsume: async () => ({ userId: "user-1", jti: "jti-1", meetingSessionId: "call-1", turnId: "turn-1", chatId: "chat-1", issuedAtSeconds: 1, expiresAtSeconds: 2 }),
  } as unknown as VoiceTurnTokenVerifier;
  await withServer(() => true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/voice/turns/turn-1/audio`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "audio/webm", "content-length": "3" },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(response.status, 202);
    assert.equal(uploads.length, 1);
  }, { logger, turnTokenVerifier: verifier, onBatchAudio: (upload) => { uploads.push(upload); } });
});

test("returns 503 when readiness is false", async () => {
  await withServer(() => false, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready", service: "voice-service" });
  });
});

test("does not expose unimplemented routes", async () => {
  await withServer(() => true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/voice/turns/example/audio`, { method: "POST" });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  });
});

test("closes malformed requests with a generic 400 response", async () => {
  await withServer(() => true, async (_baseUrl, port) => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { body += chunk; });
      socket.once("connect", () => socket.write("INVALID HTTP REQUEST\r\n\r\n"));
      socket.once("end", () => resolve(body));
      socket.once("error", reject);
    });

    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
  });
});
