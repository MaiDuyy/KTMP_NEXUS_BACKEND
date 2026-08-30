import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import { createVoiceInternalRouter } from './internalVoiceRouter.js';
import type { VoiceTurnController } from './voiceTurnController.js';

const serviceKey = 'test-internal-service-key-with-32-characters';

async function withServer(
  controller: Partial<VoiceTurnController>,
  run: (baseUrl: string) => Promise<void>,
  metrics?: { contentType: string; render(): Promise<string> },
) {
  const app = express();
  app.use(express.json());
  app.use('/internal/voice', createVoiceInternalRouter(controller as VoiceTurnController, serviceKey, metrics));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  try {
    await run(`http://127.0.0.1:${address.port}/internal/voice`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('internal voice routes reject missing and incorrect service credentials', async () => {
  await withServer({}, async (baseUrl) => {
    for (const provided of [undefined, 'wrong-key']) {
      const response = await fetch(`${baseUrl}/turns/context`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(provided ? { 'x-voice-internal-service-key': provided } : {}),
        },
        body: '{}',
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });
});

test('internal metrics are hidden when disabled and protected when enabled', async () => {
  await withServer({}, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 404);
  });

  await withServer({}, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
    const response = await fetch(`${baseUrl}/metrics`, {
      headers: { 'x-voice-internal-service-key': serviceKey },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    assert.equal(await response.text(), '# metrics\n');
  }, { contentType: 'text/plain; version=0.0.4', render: async () => '# metrics\n' });
});

test('internal voice routes expose only current context and reject stale events', async () => {
  const context = {
    meetingSessionId: 'call-1',
    turnId: 'turn-1',
    ownerUserId: 'user-1',
    ownerName: 'User One',
    roomName: 'call-1',
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    participantIds: ['user-1'],
  };
  await withServer({
    getPipelineContext: async () => context,
    handlePipelineEvent: async () => false,
  }, async (baseUrl) => {
    const headers = {
      'content-type': 'application/json',
      'x-voice-internal-service-key': serviceKey,
    };
    const contextResponse = await fetch(`${baseUrl}/turns/context`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ meetingSessionId: 'call-1', turnId: 'turn-1', ownerUserId: 'user-1' }),
    });
    assert.equal(contextResponse.status, 200);
    assert.deepEqual(await contextResponse.json(), context);

    const staleResponse = await fetch(`${baseUrl}/turns/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ meetingSessionId: 'call-1', turnId: 'old-turn', ownerUserId: 'user-1' }),
    });
    assert.equal(staleResponse.status, 409);
  });
});
