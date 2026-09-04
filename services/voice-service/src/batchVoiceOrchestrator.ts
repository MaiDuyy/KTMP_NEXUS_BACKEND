import type { VoiceErrorCode, VoicePipelineEvent } from '@ott/shared';
import type { BatchAudioUpload } from './audioUpload.js';
import type { VerifiedVoiceTurnToken } from './turnTokenVerifier.js';
import { BatchSttError, type BatchSttResult } from './batchStt.js';
import { BatchTtsError, type BatchTtsResult } from './batchTts.js';
import { InternalServiceError, type MeetingAiRequest, type MeetingAiResponse } from './internalClients.js';
import type { MeetingAiStreamEvent } from '@ott/shared';
import {
  StreamingOutputError,
  type StreamingOutputSummary,
} from './streaming/streamingOutputOrchestrator.js';
import { VoiceError } from './livekit/MeetingAudioPublisher.js';
import type { VoiceServiceLogger } from './logger.js';
import type {
  VoicePipelineMetrics,
  VoicePipelineOutcome,
  VoicePipelineStage,
  VoiceStageOutcome,
  VoiceStreamingMetrics,
} from './voiceMetrics.js';

export interface BatchSttProvider {
  transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<BatchSttResult>;
}

export interface BatchTtsProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<BatchTtsResult>;
}

export interface VoiceControlProvider {
  getContext(request: {
    meetingSessionId: string;
    turnId: string;
    ownerUserId: string;
  }, signal?: AbortSignal): Promise<{
    meetingSessionId: string;
    turnId: string;
    ownerUserId: string;
    ownerName: string;
    roomName: string;
    chatId: string;
    workspaceId: string;
    participantIds: string[];
  }>;
  emit(event: VoicePipelineEvent, signal?: AbortSignal): Promise<void>;
}

export interface MeetingAiProvider {
  answer(request: MeetingAiRequest, signal?: AbortSignal): Promise<MeetingAiResponse>;
  stream?(request: MeetingAiRequest, signal?: AbortSignal): AsyncIterable<MeetingAiStreamEvent>;
}

export interface StreamingOutputProvider {
  run(input: {
    meetingSessionId: string;
    roomName: string;
    turnId: string;
    events: AsyncIterable<MeetingAiStreamEvent>;
    signal?: AbortSignal;
    onFirstFrame?: () => void;
    onSideChannelEvent?: (event: Extract<MeetingAiStreamEvent, { type: 'display.delta' | 'source' }>) => void | Promise<void>;
  }): Promise<StreamingOutputSummary>;
}

export interface MeetingAudioProvider {
  publish(input: {
    meetingSessionId: string;
    roomName: string;
    turnId: string;
    audio: BatchTtsResult;
    signal?: AbortSignal;
    onFirstFrame?: () => void;
  }): Promise<{ completed: boolean }>;
}

export interface BatchVoiceOrchestratorDependencies {
  stt: BatchSttProvider;
  ai: MeetingAiProvider;
  tts: BatchTtsProvider;
  publisher: MeetingAudioProvider;
  control: VoiceControlProvider;
  logger: VoiceServiceLogger;
  timeoutMs: number;
  metrics?: VoicePipelineMetrics & Partial<VoiceStreamingMetrics>;
  streamingOutput?: StreamingOutputProvider | null;
}

interface FinalTranscriptVoiceInput {
  token: VerifiedVoiceTurnToken;
  transcript: string;
  confidence: number | null;
}

const NOOP_METRICS: VoicePipelineMetrics = {
  recordStage: () => undefined,
  recordPipeline: () => undefined,
};

function failure(error: unknown): { code: VoiceErrorCode; message: string; retryable: boolean } {
  const code = error instanceof BatchSttError ||
    error instanceof BatchTtsError ||
    error instanceof VoiceError ||
    error instanceof InternalServiceError
    ? error.code
    : 'VOICE_INTERNAL_ERROR';

  const messages: Partial<Record<VoiceErrorCode, string>> = {
    VOICE_NO_SPEECH: 'Không nhận diện được giọng nói trong đoạn ghi âm.',
    VOICE_STT_TIMEOUT: 'Nhận diện giọng nói quá thời gian chờ.',
    VOICE_STT_UNAVAILABLE: 'Dịch vụ nhận diện giọng nói tạm thời không khả dụng.',
    VOICE_STT_QUOTA_EXCEEDED: 'Dịch vụ nhận diện giọng nói đã vượt quá hạn mức sử dụng.',
    VOICE_AI_TIMEOUT: 'AI trả lời quá thời gian chờ.',
    VOICE_AI_UNAVAILABLE: 'Dịch vụ AI tạm thời không khả dụng.',
    VOICE_AI_QUOTA_EXCEEDED: 'Dịch vụ AI đã vượt quá hạn mức sử dụng.',
    VOICE_TTS_TIMEOUT: 'Tạo giọng đọc quá thời gian chờ.',
    VOICE_TTS_UNAVAILABLE: 'Dịch vụ giọng đọc tạm thời không khả dụng.',
    VOICE_TTS_QUOTA_EXCEEDED: 'Dịch vụ giọng đọc đã vượt quá hạn mức sử dụng.',
    VOICE_LIVEKIT_PUBLISH_FAILED: 'Không thể phát câu trả lời AI vào cuộc họp.',
    VOICE_LIVEKIT_QUOTA_EXCEEDED: 'Dịch vụ phát âm thanh cuộc họp đã vượt quá hạn mức sử dụng.',
    VOICE_INTERNAL_ERROR: 'Không thể hoàn tất lượt AI Voice.',
  };
  return {
    code,
    message: messages[code] ?? 'Không thể hoàn tất lượt AI Voice.',
    retryable:
      code !== 'VOICE_NO_SPEECH' &&
      code !== 'VOICE_SPEECH_TOO_LONG' &&
      code !== 'VOICE_STT_QUOTA_EXCEEDED' &&
      code !== 'VOICE_AI_QUOTA_EXCEEDED' &&
      code !== 'VOICE_TTS_QUOTA_EXCEEDED' &&
      code !== 'VOICE_LIVEKIT_QUOTA_EXCEEDED',
  };
}

export class BatchVoiceOrchestrator {
  private readonly active = new Map<string, {
    meetingSessionId: string;
    controller: AbortController;
    settled: Promise<void>;
  }>();
  private readonly closingMeetings = new Set<string>();

  public constructor(private readonly dependencies: BatchVoiceOrchestratorDependencies) {
    if (!Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive integer');
    }
  }

  public enqueue(upload: BatchAudioUpload): boolean {
    return this.enqueueInput(upload);
  }

  public enqueueTranscript(input: FinalTranscriptVoiceInput): boolean {
    if (!input.transcript.trim()) return false;
    return this.enqueueInput({ ...input, transcript: input.transcript.trim() });
  }

  private enqueueInput(input: BatchAudioUpload | FinalTranscriptVoiceInput): boolean {
    const turnId = input.token.turnId;
    if (this.active.has(turnId) || this.closingMeetings.has(input.token.meetingSessionId)) return false;
    const controller = new AbortController();
    const settled = this.run(input, controller).finally(() => this.active.delete(turnId));
    this.active.set(turnId, { meetingSessionId: input.token.meetingSessionId, controller, settled });
    return true;
  }

  public cancel(turnId: string): boolean {
    const active = this.active.get(turnId);
    if (!active) return false;
    active.controller.abort('cancelled');
    return true;
  }

  public async cancelTurn(meetingSessionId: string, turnId: string): Promise<boolean> {
    const active = this.active.get(turnId);
    if (!active || active.meetingSessionId !== meetingSessionId) return false;
    active.controller.abort('turn-cancelled');
    await active.settled;
    return true;
  }

  public async cancelMeeting(meetingSessionId: string): Promise<void> {
    this.closingMeetings.add(meetingSessionId);
    const matching = [...this.active.values()].filter((active) => active.meetingSessionId === meetingSessionId);
    for (const active of matching) active.controller.abort('meeting-ended');
    await Promise.allSettled(matching.map((active) => active.settled));
  }

  public cancelAll(): void {
    for (const active of this.active.values()) {
      active.controller.abort('shutdown');
    }
  }

  public async cancelAllAndWait(): Promise<void> {
    const active = [...this.active.values()];
    for (const turn of active) turn.controller.abort('shutdown');
    await Promise.allSettled(active.map((turn) => turn.settled));
  }

  private async run(input: BatchAudioUpload | FinalTranscriptVoiceInput, controller: AbortController): Promise<void> {
    const { meetingSessionId, turnId, userId } = input.token;
    const startedAt = Date.now();
    const monotonicStartedAt = performance.now();
    const timeout = setTimeout(() => controller.abort('pipeline-timeout'), this.dependencies.timeoutMs);
    const base = { meetingSessionId, turnId, ownerUserId: userId } as const;
    const metrics = this.dependencies.metrics ?? NOOP_METRICS;
    let stage: VoicePipelineStage = 'context';
    let stageStartedAt = monotonicStartedAt;
    let stageRecorded = false;
    const recordStage = (outcome: VoiceStageOutcome): void => {
      if (stageRecorded) return;
      metrics.recordStage(stage, outcome, (performance.now() - stageStartedAt) / 1000);
      stageRecorded = true;
    };
    const moveToStage = (next: VoicePipelineStage): void => {
      recordStage('completed');
      stage = next;
      stageStartedAt = performance.now();
      stageRecorded = false;
    };
    const recordPipeline = (outcome: VoicePipelineOutcome, code: VoiceErrorCode | 'none'): void => {
      metrics.recordPipeline(outcome, code, (performance.now() - monotonicStartedAt) / 1000);
    };
    try {
      const context = await this.dependencies.control.getContext(base, controller.signal);
      moveToStage('stt');
      await this.dependencies.control.emit({ ...base, kind: 'state', state: 'FINALIZING_STT' }, controller.signal);
      const transcript = 'audio' in input
        ? await this.dependencies.stt.transcribe(input.audio, input.contentType, controller.signal)
        : { transcript: input.transcript, confidence: input.confidence };
      await this.dependencies.control.emit({
        ...base,
        kind: 'transcript',
        speakerName: context.ownerName,
        text: transcript.transcript,
        confidence: transcript.confidence,
      }, controller.signal);

      moveToStage('ai');
      await this.dependencies.control.emit({ ...base, kind: 'state', state: 'THINKING' }, controller.signal);
      const aiRequest = {
        meetingSessionId,
        chatId: context.chatId,
        workspaceId: context.workspaceId,
        turnId,
        speakerUserId: userId,
        speakerName: context.ownerName,
        participantIds: context.participantIds,
        message: transcript.transcript,
      };
      if (this.dependencies.streamingOutput && this.dependencies.ai.stream) {
        await this.runStreamingOutput(base, context, aiRequest, controller.signal);
        recordStage('completed');
        await this.dependencies.control.emit({ ...base, kind: 'terminal', state: 'COMPLETED' });
        recordPipeline('completed', 'none');
        this.dependencies.logger.info({ meetingSessionId, turnId, durationMs: Date.now() - startedAt }, 'Streaming voice turn completed');
        return;
      }
      const answer = await this.dependencies.ai.answer(aiRequest, controller.signal);
      if (answer.meetingSessionId !== meetingSessionId || answer.turnId !== turnId) {
        throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
      }
      await this.dependencies.control.emit({
        ...base,
        kind: 'message',
        displayText: answer.displayText,
        sources: [],
      }, controller.signal);

      moveToStage('tts');
      await this.dependencies.control.emit({ ...base, kind: 'state', state: 'RESPONDING' }, controller.signal);
      const audio = await this.dependencies.tts.synthesize(answer.speechText, controller.signal);

      moveToStage('livekit');
      const published = await this.dependencies.publisher.publish({
        meetingSessionId,
        roomName: context.roomName,
        turnId,
        audio,
        signal: controller.signal,
      });
      if (!published.completed) {
        throw new VoiceError('VOICE_LIVEKIT_PUBLISH_FAILED');
      }

      recordStage('completed');
      await this.dependencies.control.emit({ ...base, kind: 'terminal', state: 'COMPLETED' });
      recordPipeline('completed', 'none');
      this.dependencies.logger.info({ meetingSessionId, turnId, durationMs: Date.now() - startedAt }, 'Voice turn completed');
    } catch (error) {
      if (error instanceof InternalServiceError && error.code === 'VOICE_CANCELLED') {
        recordStage('cancelled');
        recordPipeline('ownership_expired', 'VOICE_CANCELLED');
        this.dependencies.logger.info({ meetingSessionId, turnId, stage }, 'Voice turn stopped because ownership expired');
        return;
      }
      if (controller.signal.aborted && controller.signal.reason !== 'pipeline-timeout') {
        recordStage('cancelled');
        recordPipeline('cancelled', 'VOICE_CANCELLED');
        this.dependencies.logger.info({ meetingSessionId, turnId, stage }, 'Voice turn cancelled');
        return;
      }
      const timedOut = controller.signal.reason === 'pipeline-timeout';
      const resolved = controller.signal.reason === 'pipeline-timeout'
        ? {
          code: 'VOICE_INTERNAL_ERROR' as const,
          message: 'Lượt AI Voice vượt quá thời gian xử lý cho phép.',
          retryable: true,
        }
        : failure(error);
      recordStage(timedOut ? 'timeout' : 'failed');
      recordPipeline(timedOut ? 'timeout' : 'failed', resolved.code);
      await this.dependencies.control.emit({
        ...base,
        kind: 'terminal',
        state: 'FAILED',
        ...resolved,
      }).catch(() => undefined);
      this.dependencies.logger.error({
        meetingSessionId,
        turnId,
        stage,
        code: resolved.code,
        durationMs: Date.now() - startedAt,
      }, 'Voice turn failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runStreamingOutput(
    base: { meetingSessionId: string; turnId: string; ownerUserId: string },
    context: Awaited<ReturnType<VoiceControlProvider['getContext']>>,
    request: MeetingAiRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = performance.now();
    let displayText = '';
    let revision = 0;
    let responding: Promise<void> | null = null;
    let usedBatchFallback = false;
    const sources: Array<{ documentId: string | number; title: string; chunkId: string }> = [];
    try {
      const summary = await this.dependencies.streamingOutput!.run({
        meetingSessionId: base.meetingSessionId,
        roomName: context.roomName,
        turnId: base.turnId,
        events: this.dependencies.ai.stream!(request, signal),
        signal,
        onFirstFrame: () => {
          responding ??= this.dependencies.control.emit({ ...base, kind: 'state', state: 'RESPONDING' }, signal);
        },
        onSideChannelEvent: async (event) => {
          if (event.type === 'source') {
            sources.push({ documentId: event.documentId, title: event.title, chunkId: event.chunkId });
            return;
          }
          displayText += event.text;
          revision += 1;
          const text = displayText.trim();
          if (!text) return;
          await this.dependencies.control.emit({
            ...base,
            kind: 'message_partial',
            displayText: text,
            revision,
            sources: sources.slice(0, 10),
          }, signal);
        },
      });
      const measured = summary;
      const metrics = this.dependencies.metrics;
      if (measured.startedAtMonotonicMs !== undefined && measured.firstAudioAtMonotonicMs != null) metrics?.recordStreamingOutputLatency?.('ai_start_to_first_audio', (measured.firstAudioAtMonotonicMs - measured.startedAtMonotonicMs) / 1000);
      if (measured.startedAtMonotonicMs !== undefined && measured.firstFrameAtMonotonicMs != null) metrics?.recordStreamingOutputLatency?.('ai_start_to_first_frame', (measured.firstFrameAtMonotonicMs - measured.startedAtMonotonicMs) / 1000);
      if (measured.aiDoneAtMonotonicMs !== undefined && measured.playoutCompletedAtMonotonicMs !== undefined) metrics?.recordStreamingOutputLatency?.('ai_done_to_playout', (measured.playoutCompletedAtMonotonicMs - measured.aiDoneAtMonotonicMs) / 1000);
      if (measured.startedAtMonotonicMs !== undefined && measured.playoutCompletedAtMonotonicMs !== undefined) metrics?.recordStreamingOutputLatency?.('total', (measured.playoutCompletedAtMonotonicMs - measured.startedAtMonotonicMs) / 1000);
      if (measured.speechDeltaCount !== undefined) metrics?.recordStreamingOutputVolume?.('speech_delta_count', measured.speechDeltaCount);
      if (measured.audioChunkCount !== undefined) metrics?.recordStreamingOutputVolume?.('audio_chunk_count', measured.audioChunkCount);
      if (measured.audio?.frames.frameCount !== undefined) metrics?.recordStreamingOutputVolume?.('frame_count', measured.audio.frames.frameCount);
      if (measured.audio?.frames.paddedSamples !== undefined) metrics?.recordStreamingOutputVolume?.('padded_sample_count', measured.audio.frames.paddedSamples);
    } catch (error) {
      if (!(error instanceof StreamingOutputError) || !error.aiDone || error.firstFramePublished || !error.fallbackSpeechText) {
        this.dependencies.metrics?.recordStreamingOutput?.(
          signal.aborted
            ? 'cancelled'
            : error instanceof StreamingOutputError && error.firstFramePublished
              ? 'failed_after_first_audio'
              : 'failed_before_first_audio',
          (performance.now() - startedAt) / 1000,
        );
        throw error;
      }
      const audio = await this.dependencies.tts.synthesize(error.fallbackSpeechText, signal);
      let fallbackResponding: Promise<void> | null = null;
      const published = await this.dependencies.publisher.publish({
        meetingSessionId: base.meetingSessionId,
        roomName: context.roomName,
        turnId: base.turnId,
        audio,
        signal,
        onFirstFrame: () => {
          fallbackResponding ??= this.dependencies.control.emit({ ...base, kind: 'state', state: 'RESPONDING' }, signal);
        },
      });
      await fallbackResponding;
      responding ??= fallbackResponding;
      if (!published.completed) throw new VoiceError('VOICE_LIVEKIT_PUBLISH_FAILED');
      usedBatchFallback = true;
      this.dependencies.metrics?.recordStreamingOutput?.('fallback_batch_before_first_audio', (performance.now() - startedAt) / 1000);
    }
    await responding;
    const finalDisplayText = displayText.trim();
    if (!finalDisplayText) throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
    await this.dependencies.control.emit({
      ...base,
      kind: 'message',
      displayText: finalDisplayText,
      sources: sources.slice(0, 10),
    }, signal);
    if (!usedBatchFallback) {
      this.dependencies.metrics?.recordStreamingOutput?.('completed', (performance.now() - startedAt) / 1000);
    }
  }
}
