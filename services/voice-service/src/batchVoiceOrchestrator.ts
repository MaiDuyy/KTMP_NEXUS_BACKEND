import type { VoiceErrorCode, VoicePipelineEvent } from '@ott/shared';
import type { BatchAudioUpload } from './audioUpload.js';
import { BatchSttError, type BatchSttResult } from './batchStt.js';
import { BatchTtsError, type BatchTtsResult } from './batchTts.js';
import { InternalServiceError, type MeetingAiRequest, type MeetingAiResponse } from './internalClients.js';
import { VoiceError } from './livekit/MeetingAudioPublisher.js';
import type { VoiceServiceLogger } from './logger.js';

export interface BatchSttProvider {
  transcribe(audio: Buffer, mimeType: string): Promise<BatchSttResult>;
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
}

export interface MeetingAudioProvider {
  publish(input: {
    meetingSessionId: string;
    roomName: string;
    turnId: string;
    audio: BatchTtsResult;
    signal?: AbortSignal;
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
}

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
    VOICE_AI_TIMEOUT: 'AI trả lời quá thời gian chờ.',
    VOICE_AI_UNAVAILABLE: 'Dịch vụ AI tạm thời không khả dụng.',
    VOICE_TTS_TIMEOUT: 'Tạo giọng đọc quá thời gian chờ.',
    VOICE_TTS_UNAVAILABLE: 'Dịch vụ giọng đọc tạm thời không khả dụng.',
    VOICE_LIVEKIT_PUBLISH_FAILED: 'Không thể phát câu trả lời AI vào cuộc họp.',
    VOICE_INTERNAL_ERROR: 'Không thể hoàn tất lượt AI Voice.',
  };
  return {
    code,
    message: messages[code] ?? 'Không thể hoàn tất lượt AI Voice.',
    retryable: code !== 'VOICE_NO_SPEECH' && code !== 'VOICE_SPEECH_TOO_LONG',
  };
}

export class BatchVoiceOrchestrator {
  private readonly active = new Map<string, AbortController>();

  public constructor(private readonly dependencies: BatchVoiceOrchestratorDependencies) {
    if (!Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive integer');
    }
  }

  public enqueue(upload: BatchAudioUpload): boolean {
    const turnId = upload.token.turnId;
    if (this.active.has(turnId)) return false;
    const controller = new AbortController();
    this.active.set(turnId, controller);
    void this.run(upload, controller).finally(() => this.active.delete(turnId));
    return true;
  }

  public cancel(turnId: string): boolean {
    const controller = this.active.get(turnId);
    if (!controller) return false;
    controller.abort('cancelled');
    return true;
  }

  public cancelAll(): void {
    for (const controller of this.active.values()) {
      controller.abort('shutdown');
    }
  }

  private async run(upload: BatchAudioUpload, controller: AbortController): Promise<void> {
    const { meetingSessionId, turnId, userId } = upload.token;
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort('pipeline-timeout'), this.dependencies.timeoutMs);
    const base = { meetingSessionId, turnId, ownerUserId: userId } as const;
    let stage = 'CONTEXT';
    try {
      const context = await this.dependencies.control.getContext(base, controller.signal);
      stage = 'STT';
      await this.dependencies.control.emit({ ...base, kind: 'state', state: 'FINALIZING_STT' }, controller.signal);
      const transcript = await this.dependencies.stt.transcribe(upload.audio, upload.contentType);
      await this.dependencies.control.emit({
        ...base,
        kind: 'transcript',
        speakerName: context.ownerName,
        text: transcript.transcript,
        confidence: transcript.confidence,
      }, controller.signal);

      stage = 'AI';
      await this.dependencies.control.emit({ ...base, kind: 'state', state: 'THINKING' }, controller.signal);
      const answer = await this.dependencies.ai.answer({
        meetingSessionId,
        chatId: context.chatId,
        workspaceId: context.workspaceId,
        turnId,
        speakerUserId: userId,
        speakerName: context.ownerName,
        participantIds: context.participantIds,
        message: transcript.transcript,
      }, controller.signal);
      if (answer.meetingSessionId !== meetingSessionId || answer.turnId !== turnId) {
        throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
      }
      await this.dependencies.control.emit({
        ...base,
        kind: 'message',
        displayText: answer.displayText,
        sources: [],
      }, controller.signal);

      stage = 'TTS';
      await this.dependencies.control.emit({ ...base, kind: 'state', state: 'RESPONDING' }, controller.signal);
      const audio = await this.dependencies.tts.synthesize(answer.speechText, controller.signal);

      stage = 'LIVEKIT';
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

      stage = 'COMPLETED';
      await this.dependencies.control.emit({ ...base, kind: 'terminal', state: 'COMPLETED' });
      this.dependencies.logger.info({ meetingSessionId, turnId, durationMs: Date.now() - startedAt }, 'Voice turn completed');
    } catch (error) {
      if (error instanceof InternalServiceError && error.code === 'VOICE_CANCELLED') {
        this.dependencies.logger.info({ meetingSessionId, turnId, stage }, 'Voice turn stopped because ownership expired');
        return;
      }
      if (controller.signal.aborted && controller.signal.reason !== 'pipeline-timeout') {
        this.dependencies.logger.info({ meetingSessionId, turnId, stage }, 'Voice turn cancelled');
        return;
      }
      const resolved = controller.signal.reason === 'pipeline-timeout'
        ? {
          code: 'VOICE_INTERNAL_ERROR' as const,
          message: 'Lượt AI Voice vượt quá thời gian xử lý cho phép.',
          retryable: true,
        }
        : failure(error);
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
}
