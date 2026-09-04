import assert from 'node:assert/strict';
import test from 'node:test';
import { MeetingAiClient, InternalServiceError, type MeetingAiRequest } from './internalClients.js';

const request: MeetingAiRequest = {
  meetingSessionId: 'meeting-1',
  chatId: 'chat-1',
  workspaceId: 'workspace-1',
  turnId: 'turn-1',
  speakerUserId: 'user-1',
  speakerName: 'User One',
  participantIds: ['user-1', 'user-2'],
  message: 'Question',
};

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

async function withFetch(response: Response, callback: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test('MeetingAiClient parses typed SSE across arbitrary UTF-8 and event boundaries', async () => {
  const client = new MeetingAiClient('http://meeting-ai.test/internal/meeting-ai', 'x'.repeat(32), 2_000, 500, 500);
  const speech = '{"type":"speech.delta","version":1,"turnId":"turn-1","sequence":0,"text":"Xin chào"}';
  const display = '{"type":"display.delta","version":1,"turnId":"turn-1","sequence":0,"text":"Xin chào"}';
  const done = '{"type":"done","version":1,"turnId":"turn-1","replayed":false,"latency":{"firstDeltaMs":1,"totalMs":2}}';

  await withFetch(sseResponse([
    `event: speech.delta\ndata: ${speech.slice(0, 38)}`,
    `${speech.slice(38)}\n\n:event keepalive\n\n`,
    `event: display.delta\ndata: ${display}\n\n`,
    `event: done\ndata: ${done}\n\n`,
  ]), async () => {
    const events = [];
    for await (const event of client.stream(request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['speech.delta', 'display.delta', 'done']);
    assert.equal(events[0]?.type === 'speech.delta' ? events[0].text : '', 'Xin chào');
  });
});

test('MeetingAiClient rejects sequence gaps and streams that close before done', async () => {
  const client = new MeetingAiClient('http://meeting-ai.test/internal/meeting-ai', 'x'.repeat(32), 2_000, 500, 500);
  const gap = '{"type":"speech.delta","version":1,"turnId":"turn-1","sequence":1,"text":"Late"}';

  await withFetch(sseResponse([`event: speech.delta\ndata: ${gap}\n\n`]), async () => {
    await assert.rejects(async () => {
      for await (const ignored of client.stream(request)) void ignored;
    }, (error: unknown) => error instanceof InternalServiceError && error.code === 'VOICE_AI_UNAVAILABLE');
  });

  const speech = '{"type":"speech.delta","version":1,"turnId":"turn-1","sequence":0,"text":"Only one"}';
  await withFetch(sseResponse([`event: speech.delta\ndata: ${speech}\n\n`]), async () => {
    await assert.rejects(async () => {
      for await (const ignored of client.stream(request)) void ignored;
    }, (error: unknown) => error instanceof InternalServiceError && error.code === 'VOICE_AI_UNAVAILABLE');
  });
});

test('MeetingAiClient deduplicates repeated source metadata while preserving source sequence validation', async () => {
  const client = new MeetingAiClient('http://meeting-ai.test/internal/meeting-ai', 'x'.repeat(32), 2_000, 500, 500);
  const source0 = '{"type":"source","version":1,"turnId":"turn-1","sequence":0,"documentId":"doc-1","title":"Policy","chunkId":"chunk-1"}';
  const source1 = '{"type":"source","version":1,"turnId":"turn-1","sequence":1,"documentId":"doc-1","title":"Policy","chunkId":"chunk-1"}';
  const done = '{"type":"done","version":1,"turnId":"turn-1","replayed":false}';

  await withFetch(sseResponse([
    `event: source\ndata: ${source0}\n\n`,
    `event: source\ndata: ${source1}\n\n`,
    `event: done\ndata: ${done}\n\n`,
  ]), async () => {
    const events = [];
    for await (const event of client.stream(request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['source', 'done']);
  });
});

test('MeetingAiClient rejects 2xx response with invalid Content-Type as VOICE_AI_UNAVAILABLE', async () => {
  const client = new MeetingAiClient('http://meeting-ai.test/internal/meeting-ai', 'secret', 2_000, 500, 500);

  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: 'not sse' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const iterator = client.stream(request);
    await assert.rejects(
      iterator.next(),
      (err: any) => err instanceof InternalServiceError && err.code === 'VOICE_AI_UNAVAILABLE',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('MeetingAiClient resilience: no redispatch on network drop or failure before delta', async () => {
  const client = new MeetingAiClient('http://meeting-ai.test/internal/meeting-ai', 'secret', 2_000, 500, 500);

  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error('Network failure before response');
  };

  try {
    const iterator = client.stream(request);
    await assert.rejects(
      iterator.next(),
      (err: any) => err instanceof InternalServiceError && err.code === 'VOICE_AI_UNAVAILABLE',
    );
    assert.equal(attempts, 1, 'Must not redispatch after initial failure');
  } finally {
    globalThis.fetch = original;
  }
});

test('MeetingAiClient resilience: no redispatch after first delta', async () => {
  const client = new MeetingAiClient('http://meeting-ai.test/internal/meeting-ai', 'secret', 2_000, 500, 500);

  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: speech.delta\ndata: {"type":"speech.delta","version":1,"turnId":"turn-1","sequence":0,"text":"Hello"}\n\n'
        ));
        setTimeout(() => controller.error(new Error('Network drop mid-stream')), 10);
      }
    }), { headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const iterator = client.stream(request);
    const first = await iterator.next();
    assert.equal(first.value?.type, 'speech.delta');

    await assert.rejects(
      iterator.next(),
      (err: any) => err instanceof InternalServiceError && err.code === 'VOICE_AI_UNAVAILABLE',
    );
    assert.equal(attempts, 1, 'Must not redispatch after delta received');
  } finally {
    globalThis.fetch = original;
  }
});

test('MeetingAiClient does not get stuck in HALF_OPEN when consumer breaks early / returns (HIGH-R1-03)', async () => {
  const client = new MeetingAiClient('http://meeting-ai.test/internal/meeting-ai', 'secret', 2_000, 500, 500);

  // Trip streaming circuit to OPEN
  client.streamingCircuitBreaker.recordFailure();
  client.streamingCircuitBreaker.recordFailure();
  client.streamingCircuitBreaker.recordFailure();
  assert.equal(client.streamingCircuitBreaker.getState(), 'OPEN');

  // Advance time past openDurationMs
  (client.streamingCircuitBreaker as any).lastFailureTime = Date.now() - 20_000;

  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: speech.delta\ndata: {"type":"speech.delta","version":1,"turnId":"turn-1","sequence":0,"text":"First"}\n\n'
        ));
      }
    }), { headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    // Consumer only reads 1 delta then breaks (generator.return())
    for await (const event of client.stream(request)) {
      if (event.type === 'speech.delta') {
        break;
      }
    }

    assert.equal(client.streamingCircuitBreaker.getState(), 'HALF_OPEN');

    // Next probe must NOT be rejected because permit was released in finally!
    const permit = client.streamingCircuitBreaker.acquire();
    assert.ok(permit, 'Next probe should be acquired without rejection');
    permit.recordSuccess();
    assert.equal(client.streamingCircuitBreaker.getState(), 'CLOSED');
  } finally {
    globalThis.fetch = original;
  }
});
