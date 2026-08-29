import assert from "node:assert/strict";
import test from "node:test";
import { closeVoiceServiceResources } from "./resourceCleanup.js";

test("closes LiveKit and Redis resources", async () => {
  const calls: string[] = [];
  await closeVoiceServiceResources({
    closeLivekit: () => { calls.push("livekit"); },
    closeRedis: () => { calls.push("redis"); },
  });
  assert.deepEqual(calls.sort(), ["livekit", "redis"]);
});

test("still closes Redis when LiveKit cleanup fails", async () => {
  let redisClosed = false;
  await assert.rejects(
    closeVoiceServiceResources({
      closeLivekit: () => { throw new Error("livekit failed"); },
      closeRedis: () => { redisClosed = true; },
    }),
    AggregateError,
  );
  assert.equal(redisClosed, true);
});

test("still closes LiveKit when Redis cleanup fails", async () => {
  let livekitClosed = false;
  await assert.rejects(
    closeVoiceServiceResources({
      closeLivekit: () => { livekitClosed = true; },
      closeRedis: () => { throw new Error("redis failed"); },
    }),
    AggregateError,
  );
  assert.equal(livekitClosed, true);
});
