import { Counter, Histogram, Registry } from '@prometheus-io/client';
import type { VoiceErrorCode } from '@ott/shared';

export type VoicePipelineStage = 'context' | 'stt' | 'ai' | 'tts' | 'livekit';
export type VoicePipelineOutcome = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'ownership_expired';
export type VoiceStageOutcome = 'completed' | 'failed' | 'timeout' | 'cancelled';
export type VoiceStreamOutcome =
  | 'authenticated'
  | 'finalized'
  | 'cancelled'
  | 'disconnected'
  | 'auth_timeout'
  | 'idle_or_duration_timeout'
  | 'protocol_error'
  | 'sequence_error'
  | 'backpressure'
  | 'sink_error';
export type StreamingSttOutcome = 'completed' | 'no_speech' | 'timeout' | 'unavailable' | 'cancelled';

export interface VoicePipelineMetrics {
  recordStage(stage: VoicePipelineStage, outcome: VoiceStageOutcome, durationSeconds: number): void;
  recordPipeline(outcome: VoicePipelineOutcome, code: VoiceErrorCode | 'none', durationSeconds: number): void;
}

export interface VoiceStreamingMetrics {
  recordStream(outcome: VoiceStreamOutcome): void;
  recordStreamingStt(outcome: StreamingSttOutcome, durationSeconds: number): void;
}

export class VoiceServiceMetrics implements VoicePipelineMetrics {
  public readonly registry = new Registry();
  private readonly pipelines = new Counter({
    name: 'meeting_voice_pipeline_total',
    help: 'Number of batch voice pipelines by bounded outcome and error code.',
    labelNames: ['outcome', 'code'] as const,
    registers: [this.registry],
  });
  private readonly pipelineDuration = new Histogram({
    name: 'meeting_voice_pipeline_duration_seconds',
    help: 'End-to-end duration of a batch voice pipeline.',
    labelNames: ['outcome'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 150],
    registers: [this.registry],
  });
  private readonly stageDuration = new Histogram({
    name: 'meeting_voice_pipeline_stage_duration_seconds',
    help: 'Duration of a bounded batch voice pipeline stage.',
    labelNames: ['stage', 'outcome'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
    registers: [this.registry],
  });
  private readonly streams = new Counter({
    name: 'meeting_voice_stream_total',
    help: 'Number of streaming connections and terminal transport outcomes.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly streamingSttDuration = new Histogram({
    name: 'meeting_voice_streaming_stt_duration_seconds',
    help: 'Duration of streaming STT sessions by bounded outcome.',
    labelNames: ['outcome'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 21, 34, 55, 60, 70],
    registers: [this.registry],
  });

  public recordStage(stage: VoicePipelineStage, outcome: VoiceStageOutcome, durationSeconds: number): void {
    this.stageDuration.observe({ stage, outcome }, Math.max(0, durationSeconds));
  }

  public recordPipeline(
    outcome: VoicePipelineOutcome,
    code: VoiceErrorCode | 'none',
    durationSeconds: number,
  ): void {
    this.pipelines.inc({ outcome, code });
    this.pipelineDuration.observe({ outcome }, Math.max(0, durationSeconds));
  }

  public recordStream(outcome: VoiceStreamOutcome): void {
    this.streams.inc({ outcome });
  }

  public recordStreamingStt(outcome: StreamingSttOutcome, durationSeconds: number): void {
    this.streamingSttDuration.observe({ outcome }, Math.max(0, durationSeconds));
  }

  public render(): Promise<string> {
    return this.registry.metrics();
  }

  public get contentType(): string {
    return this.registry.contentType;
  }
}
