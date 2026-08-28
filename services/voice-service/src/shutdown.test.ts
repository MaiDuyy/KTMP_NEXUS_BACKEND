import assert from "node:assert/strict";
import test from "node:test";
import { createGracefulShutdown, type ClosableServer } from "./shutdown.js";
import type { VoiceServiceLogger } from "./logger.js";

const logger: VoiceServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

test("closes once when shutdown is requested more than once", async () => {
  let closeCalls = 0;
  const server: ClosableServer = {
    close: (callback) => {
      closeCalls += 1;
      callback();
    },
  };
  const exits: number[] = [];
  const shutdown = createGracefulShutdown({
    server,
    logger,
    timeoutMs: 100,
    exit: (code) => exits.push(code),
  });

  await Promise.all([shutdown("SIGINT"), shutdown("SIGTERM")]);

  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, [0]);
});
