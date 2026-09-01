import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceServiceMetrics } from './voiceMetrics.js';

test('voice service metrics use bounded stage, outcome and error-code labels', async () => {
  const metrics = new VoiceServiceMetrics();
  metrics.recordStage('stt', 'completed', 0.25);
  metrics.recordPipeline('failed', 'VOICE_STT_TIMEOUT', 0.5);
  metrics.recordStream('backpressure');
  metrics.recordStreamingStt('timeout', 1.5);
  const output = await metrics.render();

  assert.match(output, /meeting_voice_pipeline_total\{outcome="failed",code="VOICE_STT_TIMEOUT"\} 1/);
  assert.match(output, /meeting_voice_pipeline_stage_duration_seconds_count\{stage="stt",outcome="completed"\} 1/);
  assert.match(output, /meeting_voice_stream_total\{outcome="backpressure"\} 1/);
  assert.match(output, /meeting_voice_streaming_stt_duration_seconds_count\{outcome="timeout"\} 1/);
  assert.doesNotMatch(output, /meetingSessionId|turnId|workspaceId|userId|transcript/);
});
