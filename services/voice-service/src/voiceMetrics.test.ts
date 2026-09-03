import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceServiceMetrics } from './voiceMetrics.js';

test('voice service metrics use bounded stage, outcome and error-code labels', async () => {
  const metrics = new VoiceServiceMetrics();
  metrics.recordStage('stt', 'completed', 0.25);
  metrics.recordPipeline('failed', 'VOICE_STT_TIMEOUT', 0.5);
  metrics.recordStream('backpressure');
  metrics.recordStreamingStt('timeout', 1.5);
  metrics.recordStreamingOutput('fallback_batch_before_first_audio', 2.5);
  metrics.recordStreamingOutputLatency('ai_start_to_first_frame', 0.75);
  metrics.recordStreamingOutputVolume('frame_count', 42);
  metrics.recordLifecycleCleanup('streaming_livekit', 'failed');
  const output = await metrics.render();

  assert.match(output, /meeting_voice_pipeline_total\{outcome="failed",code="VOICE_STT_TIMEOUT"\} 1/);
  assert.match(output, /meeting_voice_pipeline_stage_duration_seconds_count\{stage="stt",outcome="completed"\} 1/);
  assert.match(output, /meeting_voice_stream_total\{outcome="backpressure"\} 1/);
  assert.match(output, /meeting_voice_streaming_stt_duration_seconds_count\{outcome="timeout"\} 1/);
  assert.match(output, /meeting_voice_streaming_output_duration_seconds_count\{outcome="fallback_batch_before_first_audio"\} 1/);
  assert.match(output, /meeting_voice_streaming_output_latency_seconds_count\{stage="ai_start_to_first_frame"\} 1/);
  assert.match(output, /meeting_voice_streaming_output_volume_count\{kind="frame_count"\} 1/);
  assert.match(output, /meeting_voice_lifecycle_cleanup_total\{resource="streaming_livekit",outcome="failed"\} 1/);
  assert.doesNotMatch(output, /meetingSessionId|turnId|workspaceId|userId|transcript/);
});
