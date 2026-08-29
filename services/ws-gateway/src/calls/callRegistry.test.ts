import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';
import { RedisCallParticipantRegistry } from './callRegistry.js';

test('updates call status atomically without recreating a deleted registry key', async () => {
  const calls: unknown[][] = [];
  const redis = {
    eval: async (...args: unknown[]) => {
      calls.push(args);
      return 1;
    },
  } as unknown as Redis;
  const registry = new RedisCallParticipantRegistry(redis, 120);

  assert.equal(await registry.updateStatus('meeting-1', 'ending'), true);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /EXISTS/);
  assert.deepEqual(calls[0].slice(1, 4), [1, 'call:meeting-1:meta', 'ending']);
  assert.equal(calls[0][5], 120);
});

test('reports a missing call registry without issuing a separate existence check', async () => {
  let evaluations = 0;
  const redis = {
    eval: async () => {
      evaluations += 1;
      return 0;
    },
  } as unknown as Redis;
  const registry = new RedisCallParticipantRegistry(redis);

  assert.equal(await registry.updateStatus('meeting-1', 'ended'), false);
  assert.equal(evaluations, 1);
});
