import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import test from 'node:test';
import express from 'express';

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test('voice upload route forwards raw audio and turn authorization without user JWT middleware', async (context) => {
  const received: Array<{ path: string; authorization?: string; contentType?: string; body: Buffer }> = [];
  const voiceService = createServer(async (request, response) => {
    received.push({
      path: request.url ?? '',
      ...(typeof request.headers.authorization === 'string'
        ? { authorization: request.headers.authorization }
        : {}),
      ...(typeof request.headers['content-type'] === 'string'
        ? { contentType: request.headers['content-type'] }
        : {}),
      body: await readBody(request),
    });
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'accepted' }));
  });
  await new Promise<void>((resolve) => voiceService.listen(0, '127.0.0.1', resolve));
  context.after(() => voiceService.close());

  const address = voiceService.address();
  assert(address && typeof address === 'object');
  process.env.VOICE_SERVICE_URL = `http://127.0.0.1:${address.port}`;
  const { voiceUploadRoutes } = await import('./proxy.js');

  const app = express();
  app.use(voiceUploadRoutes);
  const gateway = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => gateway.once('listening', resolve));
  context.after(() => gateway.close());
  const gatewayAddress = gateway.address();
  assert(gatewayAddress && typeof gatewayAddress === 'object');
  const baseUrl = `http://127.0.0.1:${gatewayAddress.port}`;

  const audio = Buffer.from('webm-test-audio');
  const response = await fetch(`${baseUrl}/voice/turns/turn-123/audio`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-turn-token',
      'content-type': 'audio/webm;codecs=opus',
      'content-length': String(audio.length),
    },
    body: audio,
  });
  assert.equal(response.status, 202);
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/v1/voice/turns/turn-123/audio');
  assert.equal(received[0].authorization, 'Bearer test-turn-token');
  assert.equal(received[0].contentType, 'audio/webm;codecs=opus');
  assert.deepEqual(received[0].body, audio);

  const rejected = await fetch(`${baseUrl}/voice/turns/turn-456/audio`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'not audio',
  });
  assert.equal(rejected.status, 415);
  assert.equal(received.length, 1);
});
