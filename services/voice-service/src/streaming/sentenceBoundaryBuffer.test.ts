import assert from 'node:assert/strict';
import test from 'node:test';
import { SentenceBoundaryBuffer, type SpeechSegment } from './sentenceBoundaryBuffer.js';

function fixture(
  config: Partial<ConstructorParameters<typeof SentenceBoundaryBuffer>[0]['config']> = {},
  signal?: AbortSignal,
) {
  const emitted: SpeechSegment[] = [];
  const buffer = new SentenceBoundaryBuffer({
    turnId: 'turn-1',
    config: { minimumChars: 8, targetChars: 24, maximumChars: 40, maximumBytes: 80, flushTimeoutMs: 100, ...config },
    signal,
    onSegment: (segment) => {
      emitted.push(segment);
    },
  });
  return { buffer, emitted };
}

function delta(sequence: number, text: string) {
  return { turnId: 'turn-1', sequence, text };
}

test('segments punctuation in order without treating decimals as sentence endings', async () => {
  const { buffer, emitted } = fixture();
  await buffer.push(delta(0, 'Doanh thu là 1.5 tỷ đồng. Kế hoạch tiếp theo?'));
  await buffer.finish();
  assert.deepEqual(emitted.map((segment) => segment.text), ['Doanh thu là 1.5 tỷ đồng.', 'Kế hoạch tiếp theo?']);
  assert.deepEqual(emitted.map((segment) => segment.reason), ['punctuation', 'punctuation']);
  assert.deepEqual(emitted.map((segment) => segment.segmentSequence), [0, 1]);
});

test('uses a bounded length flush and flushes remainder once on done', async () => {
  const { buffer, emitted } = fixture();
  await buffer.push(delta(0, 'Một chuỗi văn bản dài không có dấu kết thúc nhưng vẫn cần được chia theo giới hạn bộ nhớ'));
  await buffer.finish();
  assert.ok(emitted.length >= 2);
  assert.ok(emitted.every((segment) => Buffer.byteLength(segment.text, 'utf8') <= 80));
  assert.equal(emitted.at(-1)?.reason, 'done');
  assert.equal(emitted.map((segment) => segment.text).join(' '), 'Một chuỗi văn bản dài không có dấu kết thúc nhưng vẫn cần được chia theo giới hạn bộ nhớ');
});

test('cancelling clears pending text and prevents later writes', async () => {
  const { buffer, emitted } = fixture();
  await buffer.push(delta(0, 'Đoạn chờ bị hủy'));
  await buffer.cancel();
  await assert.rejects(buffer.push(delta(1, 'không hợp lệ')), /terminal/);
  assert.deepEqual(emitted, []);
});

test('rejects duplicate, gap, and cross-turn speech deltas', async () => {
  const { buffer } = fixture();
  await buffer.push(delta(0, 'mot delta hop le'));
  await assert.rejects(buffer.push(delta(0, 'trung lap')), /invalid delta sequence/);
  await assert.rejects(buffer.push(delta(2, 'nhay sequence')), /invalid delta sequence/);
  await assert.rejects(buffer.push({ turnId: 'turn-khac', sequence: 1, text: 'sai turn' }), /invalid delta sequence/);
  await buffer.finish();
});

test('preserves Unicode across delta boundaries and flushes pending text on timeout', async () => {
  const { buffer, emitted } = fixture({ minimumChars: 99, targetChars: 99, maximumChars: 100, flushTimeoutMs: 20 });
  await buffer.push(delta(0, 'Xin '));
  await buffer.push(delta(1, 'chào Việt Nam'));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(emitted.map((segment) => ({ text: segment.text, reason: segment.reason })), [
    { text: 'Xin chào Việt Nam', reason: 'timeout' },
  ]);
  await buffer.finish();
});

test('flushes a preserved newline after the configured minimum length', async () => {
  const { buffer, emitted } = fixture();
  await buffer.push(delta(0, 'Dong thu nhat\nDong thu hai'));
  await buffer.finish();
  assert.deepEqual(emitted.map((segment) => ({ text: segment.text, reason: segment.reason })), [
    { text: 'Dong thu nhat', reason: 'punctuation' },
    { text: 'Dong thu hai', reason: 'done' },
  ]);
});

test('cancels pending text through AbortSignal', async () => {
  const controller = new AbortController();
  const { buffer, emitted } = fixture({}, controller.signal);
  await buffer.push(delta(0, 'doan van dang cho'));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(buffer.push(delta(1, 'khong duoc phep')), /terminal/);
  assert.deepEqual(emitted, []);
});
