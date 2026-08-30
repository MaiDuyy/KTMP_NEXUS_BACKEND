import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceControlMetrics } from './voiceMetrics.js';

test('voice control metrics expose only bounded outcome and state labels', async () => {
  const metrics = new VoiceControlMetrics();
  metrics.recordStart('accepted', 0.02);
  metrics.recordStart('locked', 0.03);
  metrics.recordTerminal('COMPLETED');
  metrics.recordCleanup('retry_failed');
  metrics.setPendingCleanup(2);
  const output = await metrics.render();

  assert.match(output, /meeting_voice_turn_start_total\{outcome="accepted"\} 1/);
  assert.match(output, /meeting_voice_turn_start_total\{outcome="locked"\} 1/);
  assert.match(output, /meeting_voice_turn_terminal_total\{state="completed"\} 1/);
  assert.match(output, /meeting_voice_cleanup_total\{outcome="retry_failed"\} 1/);
  assert.match(output, /meeting_voice_cleanup_pending 2/);
  assert.doesNotMatch(output, /meetingSessionId|turnId|workspaceId|userId|transcript/);
});
