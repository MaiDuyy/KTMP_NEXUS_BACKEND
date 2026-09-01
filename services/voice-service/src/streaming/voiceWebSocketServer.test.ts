import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import { createVoiceHttpServer } from '../httpServer.js';
import type { VoiceServiceLogger } from '../logger.js';
import type { VoiceTurnTokenVerifier } from '../turnTokenVerifier.js';
import {
  type VoicePcmStreamSink,
  type VoicePcmStreamSinkFactory,
  type VoiceWebSocketServerOptions,
} from './voiceWebSocketServer.js';

const ORIGIN = 'http://localhost:3000';
const logger: VoiceServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

function verifier(consume?: () => boolean): VoiceTurnTokenVerifier {
  return {
    verifyAndConsume: async () => {
      if (consume && !consume()) throw new Error('replayed');
      return {
        userId: 'user-1',
        jti: 'jti-1',
        meetingSessionId: 'meeting-1',
        turnId: 'turn-1',
        chatId: 'chat-1',
        issuedAtSeconds: 1,
        expiresAtSeconds: 9_999_999_999,
      };
    },
  } as unknown as VoiceTurnTokenVerifier;
}

function streamingOptions(
  sinkFactory: VoicePcmStreamSinkFactory,
  overrides: Partial<VoiceWebSocketServerOptions> = {},
): VoiceWebSocketServerOptions {
  return {
    logger,
    verifier: verifier(),
    sinkFactory,
    allowedOrigins: new Set([ORIGIN]),
    authTimeoutMs: 500,
    idleTimeoutMs: 2_000,
    maxDurationMs: 5_000,
    maxQueuedBytes: 2_560,
    ...overrides,
  };
}

async function listen(streaming: VoiceWebSocketServerOptions): Promise<{ server: Server; url: string }> {
  const server = createVoiceHttpServer({ logger, streaming });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${address.port}/v1/voice/turns/turn-1/stream` };
}

function connect(url: string, origin = ORIGIN): Promise<WebSocket> {
  const socket = new WebSocket(url, { origin });
  return once(socket, 'open').then(() => socket);
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return once(socket, 'message').then(([data]) => JSON.parse(data.toString()) as Record<string, unknown>);
}

function nextJsonMessages(socket: WebSocket, count: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const listener = (data: RawData) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (messages.length === count) {
        socket.off('message', listener);
        resolve(messages);
      }
    };
    socket.on('message', listener);
  });
}

function auth(socket: WebSocket, turnId = 'turn-1'): void {
  socket.send(JSON.stringify({ type: 'auth', protocolVersion: 1, turnId, turnToken: 'test-token' }));
}

function audioFrame(sequence: number): Buffer {
  const frame = Buffer.alloc(646);
  frame.writeUInt8(1, 0);
  frame.writeUInt8(1, 1);
  frame.writeUInt32BE(sequence, 2);
  return frame;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('authenticates, acknowledges contiguous PCM and finalizes once', async () => {
  const writes: number[] = [];
  const endings: Array<number | null> = [];
  const cancellations: string[] = [];
  const sink: VoicePcmStreamSink = {
    write: ({ sequence }) => { writes.push(sequence); },
    end: (sequence) => { endings.push(sequence); },
    cancel: (reason) => { cancellations.push(reason); },
  };
  const { server, url } = await listen(streamingOptions({ open: () => sink }));
  try {
    const socket = await connect(url);
    auth(socket);
    assert.equal((await nextJson(socket)).type, 'ready');

    socket.send(audioFrame(0));
    assert.deepEqual(await nextJson(socket), { type: 'ack', sequence: 0, queuedBytes: 0 });
    socket.send(audioFrame(1));
    assert.deepEqual(await nextJson(socket), { type: 'ack', sequence: 1, queuedBytes: 0 });
    socket.send(JSON.stringify({ type: 'end', finalSequence: 1 }));
    assert.deepEqual(await nextJson(socket), { type: 'finalized', finalSequence: 1 });
    await once(socket, 'close');

    assert.deepEqual(writes, [0, 1]);
    assert.deepEqual(endings, [1]);
    assert.deepEqual(cancellations, []);
  } finally {
    await closeServer(server);
  }
});

test('drains accepted audio before finalizing when the sink is slower than the socket', async () => {
  const writes: number[] = [];
  const endings: Array<number | null> = [];
  const sink: VoicePcmStreamSink = {
    write: async ({ sequence }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      writes.push(sequence);
    },
    end: (sequence) => { endings.push(sequence); },
    cancel: () => undefined,
  };
  const { server, url } = await listen(streamingOptions({ open: () => sink }));
  try {
    const socket = await connect(url);
    auth(socket);
    await nextJson(socket);
    const responses = nextJsonMessages(socket, 3);
    socket.send(audioFrame(0));
    socket.send(audioFrame(1));
    socket.send(JSON.stringify({ type: 'end', finalSequence: 1 }));
    assert.deepEqual((await responses).map((message) => message.type), ['ack', 'ack', 'finalized']);
    await once(socket, 'close');
    assert.deepEqual(writes, [0, 1]);
    assert.deepEqual(endings, [1]);
  } finally {
    await closeServer(server);
  }
});

test('rejects origin, turn binding mismatch and replayed token', async () => {
  const noOpSink: VoicePcmStreamSink = { write: () => undefined, end: () => undefined, cancel: () => undefined };
  let consumed = false;
  const options = streamingOptions({ open: () => noOpSink }, {
    verifier: verifier(() => {
      if (consumed) return false;
      consumed = true;
      return true;
    }),
  });
  const { server, url } = await listen(options);
  try {
    const forbidden = new WebSocket(url, { origin: 'https://evil.example' });
    const [error] = await once(forbidden, 'error');
    assert.match(String(error), /403/);

    const mismatch = await connect(url);
    auth(mismatch, 'turn-other');
    assert.equal((await nextJson(mismatch)).code, 'VOICE_TOKEN_INVALID');
    await once(mismatch, 'close');

    const first = await connect(url);
    auth(first);
    assert.equal((await nextJson(first)).type, 'ready');
    first.send(JSON.stringify({ type: 'cancel', reason: 'user_cancelled' }));
    await once(first, 'close');

    const replay = await connect(url);
    auth(replay);
    assert.equal((await nextJson(replay)).code, 'VOICE_TOKEN_INVALID');
    await once(replay, 'close');
  } finally {
    await closeServer(server);
  }
});

test('fails closed on sequence gap and bounded queue overflow', async () => {
  const gapServer = await listen(streamingOptions({
    open: () => ({ write: () => undefined, end: () => undefined, cancel: () => undefined }),
  }));
  try {
    const socket = await connect(gapServer.url);
    auth(socket);
    await nextJson(socket);
    socket.send(audioFrame(1));
    assert.equal((await nextJson(socket)).code, 'VOICE_STREAM_SEQUENCE_ERROR');
    await once(socket, 'close');
  } finally {
    await closeServer(gapServer.server);
  }

  let releaseWrite!: () => void;
  const blockedWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const queueServer = await listen(streamingOptions({
    open: () => ({ write: () => blockedWrite, end: () => undefined, cancel: () => undefined }),
  }, { maxQueuedBytes: 640 }));
  try {
    const socket = await connect(queueServer.url);
    auth(socket);
    await nextJson(socket);
    socket.send(audioFrame(0));
    socket.send(audioFrame(1));
    assert.equal((await nextJson(socket)).code, 'VOICE_STREAM_BACKPRESSURE');
    releaseWrite();
    await once(socket, 'close');
  } finally {
    releaseWrite();
    await closeServer(queueServer.server);
  }
});

test('enforces auth timeout and cancels an authenticated sink on disconnect', async () => {
  const cancellations: string[] = [];
  const { server, url } = await listen(streamingOptions({
    open: () => ({
      write: () => undefined,
      end: () => undefined,
      cancel: (reason) => { cancellations.push(reason); },
    }),
  }, { authTimeoutMs: 30 }));
  try {
    const unauthenticated = await connect(url);
    assert.equal((await nextJson(unauthenticated)).code, 'VOICE_STREAM_AUTH_TIMEOUT');
    await once(unauthenticated, 'close');

    const active = await connect(url);
    auth(active);
    await nextJson(active);
    active.terminate();
    await once(active, 'close');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(cancellations, ['owner_disconnected']);
  } finally {
    await closeServer(server);
  }
});
