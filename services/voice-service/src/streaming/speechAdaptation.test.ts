import assert from 'node:assert/strict';
import test from 'node:test';
import type { VoicePipelineContextResponse } from '@ott/shared';
import { CachedSpeechAdaptationProvider, normalizeSpeechPhrases } from './speechAdaptation.js';

const context: VoicePipelineContextResponse = {
  meetingSessionId: 'meeting-1',
  turnId: 'turn-1',
  ownerUserId: 'user-1',
  ownerName: 'Nguyễn Quỳnh',
  roomName: 'room-1',
  chatId: 'chat-1',
  workspaceId: 'workspace-1',
  participantIds: ['user-1'],
};

test('normalizes, deduplicates and bounds speech phrases', () => {
  const values = [' Nexus  ERP ', 'nexus erp', 'x'.repeat(101), ...Array.from({ length: 110 }, (_, i) => `term-${i}`)];
  const phrases = normalizeSpeechPhrases(values);
  assert.equal(phrases[0], 'Nexus ERP');
  assert.equal(phrases.length, 100);
  assert.equal(phrases.includes('x'.repeat(101)), false);
});

test('caches workspace phrases and fails open with the owner name', async () => {
  let calls = 0;
  let now = 0;
  const provider = new CachedSpeechAdaptationProvider({
    load: async () => {
      calls += 1;
      if (calls > 1) throw new Error('source unavailable');
      return ['Công nghệ thông tin', 'Nguyễn Quỳnh'];
    },
  }, 100, () => now);

  assert.deepEqual(await provider.getPhrases(context), ['Nguyễn Quỳnh', 'Công nghệ thông tin']);
  assert.deepEqual(await provider.getPhrases(context), ['Nguyễn Quỳnh', 'Công nghệ thông tin']);
  assert.equal(calls, 1);
  now = 101;
  assert.deepEqual(await provider.getPhrases(context), ['Nguyễn Quỳnh']);
  assert.equal(calls, 2);
});
