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
