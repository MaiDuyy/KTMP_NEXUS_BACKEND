import type { VoicePipelineEvent } from '@ott/shared';
import type { VerifiedVoiceTurnToken } from '../turnTokenVerifier.js';
import type { VoiceControlProvider } from '../batchVoiceOrchestrator.js';
import type {
  VoicePcmChunk,
  VoicePcmStreamSink,
  VoicePcmStreamSinkFactory,
} from './voiceWebSocketServer.js';
import {
  StreamingSttError,
  type GoogleStreamingSttAdapter,
  type StreamingSttResult,
  type StreamingSttSession,
} from './googleStreamingStt.js';

export interface FinalTranscriptPipeline {
  enqueueTranscript(input: {
    token: VerifiedVoiceTurnToken;
    transcript: string;
    confidence: number | null;
  }): boolean;
}

interface FinalSegment {
  key: string;
  text: string;
  confidence: number | null;
}

export class StreamingVoiceSinkFactory implements VoicePcmStreamSinkFactory {
  public constructor(private readonly dependencies: {
    stt: GoogleStreamingSttAdapter;
    control: VoiceControlProvider;
    pipeline: FinalTranscriptPipeline;
  }) {}

  public async open(token: VerifiedVoiceTurnToken, signal: AbortSignal): Promise<VoicePcmStreamSink> {
    const base = {
      meetingSessionId: token.meetingSessionId,
      turnId: token.turnId,
      ownerUserId: token.userId,
    } as const;
    const context = await this.dependencies.control.getContext(base, signal);
    const finals = new Map<string, FinalSegment>();
    let interim = '';
    let revision = 0;
    let terminal = false;
    let ending = false;
    let emitQueue = Promise.resolve();
    let terminalEmitted = false;

    const emitTerminal = async (event: Extract<VoicePipelineEvent, { kind: 'terminal' }>) => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      await this.dependencies.control.emit(event).catch(() => undefined);
    };

    const emitProviderFailure = async (error: unknown) => {
      const code = error instanceof StreamingSttError ? error.code : 'VOICE_STT_UNAVAILABLE';
      if (code === 'VOICE_CANCELLED') {
        await emitTerminal({
          ...base,
          kind: 'terminal',
          state: 'CANCELLED',
          code,
          message: 'Lượt truyền âm thanh đã bị hủy.',
          retryable: true,
        });
        return;
      }
      await emitTerminal({
        ...base,
        kind: 'terminal',
        state: 'FAILED',
        code,
        message: code === 'VOICE_STT_TIMEOUT'
          ? 'Nhận diện giọng nói trực tiếp quá thời gian chờ.'
          : 'Dịch vụ nhận diện giọng nói trực tiếp tạm thời không khả dụng.',
        retryable: true,
      });
    };

    const orderedFinals = () => [...finals.values()].sort((left, right) => left.key.localeCompare(right.key));
    const displayText = () => [...orderedFinals().map(({ text }) => text), interim].filter(Boolean).join(' ').trim();
    const enqueuePartial = (result: StreamingSttResult) => {
      if (terminal || signal.aborted) return;
      if (result.isFinal) {
        finals.set(result.resultEndOffset, {
          key: result.resultEndOffset,
          text: result.text,
          confidence: result.confidence,
        });
        interim = '';
      } else {
        interim = result.text;
      }
      const text = displayText();
      if (!text) return;
      revision += 1;
      const event: VoicePipelineEvent = {
        ...base,
        kind: 'transcript_partial',
        speakerName: context.ownerName,
        text,
        stability: result.stability,
        revision,
      };
      emitQueue = emitQueue.then(() => this.dependencies.control.emit(event, signal));
    };

    const session: StreamingSttSession = this.dependencies.stt.open({ onResult: enqueuePartial }, signal);

    return {
      write: async (chunk: VoicePcmChunk) => {
        try {
          await session.write(chunk.pcm);
        } catch (error) {
          terminal = true;
          await emitProviderFailure(error);
          throw error;
        }
      },
      end: async () => {
        if (terminal || ending) return;
        ending = true;
        try {
          await session.finish();
        } catch (error) {
          terminal = true;
          await emitProviderFailure(error);
          throw error;
        }
        await emitQueue;
        terminal = true;
        const segments = orderedFinals();
        const transcript = segments.map(({ text }) => text).join(' ').trim();
        if (!transcript) {
          await emitTerminal({
            ...base,
            kind: 'terminal',
            state: 'FAILED',
            code: 'VOICE_NO_SPEECH',
            message: 'Không nhận diện được giọng nói trong lượt hỏi.',
            retryable: false,
          });
          return;
        }
        const confidences = segments.map(({ confidence }) => confidence).filter((value): value is number => value !== null);
        const confidence = confidences.length > 0
          ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
          : null;
        if (!this.dependencies.pipeline.enqueueTranscript({ token, transcript, confidence })) {
          throw new Error('VOICE_TURN_EXPIRED');
        }
      },
      cancel: async () => {
        if (terminal) return;
        terminal = true;
        session.cancel();
        await emitQueue.catch(() => undefined);
        await emitTerminal({
          ...base,
          kind: 'terminal',
          state: 'CANCELLED',
          code: 'VOICE_CANCELLED',
          message: 'Lượt truyền âm thanh đã bị hủy.',
          retryable: true,
        });
      },
    };
  }
}
