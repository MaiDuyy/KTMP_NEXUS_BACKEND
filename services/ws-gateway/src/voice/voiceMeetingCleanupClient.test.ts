import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { VoiceMeetingCleanupClient } from './voiceMeetingCleanupClient.js';

test('VoiceMeetingCleanupClient authenticates, preserves cleanup id and retries transient failure', async (context) => {
  const requests: Array<{ url: string; key?: string; cleanupId?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? '',
      ...(typeof request.headers['x-voice-internal-service-key'] === 'string'
        ? { key: request.headers['x-voice-internal-service-key'] }
        : {}),
      ...(typeof request.headers['x-voice-cleanup-id'] === 'string'
        ? { cleanupId: request.headers['x-voice-cleanup-id'] }
        : {}),
    });
    response.writeHead(requests.length === 1 ? 503 : 200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const client = new VoiceMeetingCleanupClient(
    `http://127.0.0.1:${address.port}/internal/voice`,
    'test-internal-service-key-with-32-characters',
    2_000,
    2,
  );

  await client.cleanupMeeting('call/one', 'cleanup-1');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/internal/voice/meetings/call%2Fone/cleanup');
  assert.equal(requests[1].key, 'test-internal-service-key-with-32-characters');
  assert.equal(requests[1].cleanupId, 'cleanup-1');
});
