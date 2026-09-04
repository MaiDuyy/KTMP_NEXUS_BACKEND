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
import type { SpeechAdaptationProvider } from './speechAdaptation.js';
import type { StreamingSttOutcome, VoiceStreamingMetrics } from '../voiceMetrics.js';
import { getResilienceObserver } from '../resilience.js';

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
  private readonly activeByMeeting = new Map<string, Map<string, VoicePcmStreamSink>>();

  public constructor(private readonly dependencies: {
    stt: GoogleStreamingSttAdapter;
    control: VoiceControlProvider;
    pipeline: FinalTranscriptPipeline;
    adaptation?: SpeechAdaptationProvider;
    metrics?: Pick<VoiceStreamingMetrics, 'recordStreamingStt'>;
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
    const startedAt = performance.now();
    let metricRecorded = false;
    const recordStt = (outcome: StreamingSttOutcome) => {
      if (metricRecorded) return;
      metricRecorded = true;
      this.dependencies.metrics?.recordStreamingStt(outcome, (performance.now() - startedAt) / 1000);
    };

    const emitTerminal = async (event: Extract<VoicePipelineEvent, { kind: 'terminal' }>) => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      await this.dependencies.control.emit(event).catch(() => undefined);
    };

    const emitProviderFailure = async (error: unknown) => {
      const code = error instanceof StreamingSttError ? error.code : 'VOICE_STT_UNAVAILABLE';
      recordStt(code === 'VOICE_CANCELLED' ? 'cancelled' : code === 'VOICE_STT_TIMEOUT' ? 'timeout' : 'unavailable');
      if (code === 'VOICE_STT_QUOTA_EXCEEDED') {
        getResilienceObserver()?.recordQuotaRejection('google_stt');
      }
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
      const isQuota = code === 'VOICE_STT_QUOTA_EXCEEDED';
      await emitTerminal({
        ...base,
        kind: 'terminal',
        state: 'FAILED',
        code,
        message: isQuota
          ? 'Dịch vụ nhận diện giọng nói trực tiếp đã vượt quá hạn mức sử dụng.'
          : code === 'VOICE_STT_TIMEOUT'
          ? 'Nhận diện giọng nói trực tiếp quá thời gian chờ.'
          : 'Dịch vụ nhận diện giọng nói trực tiếp tạm thời không khả dụng.',
        retryable: !isQuota,
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

    const phrases = await this.dependencies.adaptation?.getPhrases(context).catch(() => []) ?? [];
    const session: StreamingSttSession = this.dependencies.stt.open({ onResult: enqueuePartial }, signal, phrases);

    let sink!: VoicePcmStreamSink;
    const untrack = () => {
      const meetingSinks = this.activeByMeeting.get(token.meetingSessionId);
      if (meetingSinks?.get(token.turnId) === sink) meetingSinks.delete(token.turnId);
      if (meetingSinks?.size === 0) this.activeByMeeting.delete(token.meetingSessionId);
    };
    sink = {
      write: async (chunk: VoicePcmChunk) => {
        try {
          await session.write(chunk.pcm);
        } catch (error) {
          terminal = true;
          await emitProviderFailure(error);
          untrack();
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
          untrack();
          throw error;
        }
        await emitQueue;
        terminal = true;
        const segments = orderedFinals();
        const transcript = segments.map(({ text }) => text).join(' ').trim();
        if (!transcript) {
          recordStt('no_speech');
          await emitTerminal({
            ...base,
            kind: 'terminal',
            state: 'FAILED',
            code: 'VOICE_NO_SPEECH',
            message: 'Không nhận diện được giọng nói trong lượt hỏi.',
            retryable: false,
          });
          untrack();
          return;
        }
        const confidences = segments.map(({ confidence }) => confidence).filter((value): value is number => value !== null);
        const confidence = confidences.length > 0
          ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
          : null;
        if (!this.dependencies.pipeline.enqueueTranscript({ token, transcript, confidence })) {
          recordStt('unavailable');
          untrack();
          throw new Error('VOICE_TURN_EXPIRED');
        }
        recordStt('completed');
        untrack();
      },
      cancel: async () => {
        if (terminal) return;
        terminal = true;
        recordStt('cancelled');
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
        untrack();
      },
    };
    const meetingSinks = this.activeByMeeting.get(token.meetingSessionId) ?? new Map<string, VoicePcmStreamSink>();
    meetingSinks.set(token.turnId, sink);
    this.activeByMeeting.set(token.meetingSessionId, meetingSinks);
    return sink;
  }

  public async cancelTurn(meetingSessionId: string, turnId: string): Promise<boolean> {
    const sink = this.activeByMeeting.get(meetingSessionId)?.get(turnId);
    if (!sink) return false;
    await sink.cancel('user_cancelled');
    return true;
  }

  public async cancelMeeting(meetingSessionId: string): Promise<void> {
    const sinks = [...(this.activeByMeeting.get(meetingSessionId)?.values() ?? [])];
    await Promise.allSettled(sinks.map((sink) => Promise.resolve(sink.cancel('call_ended'))));
    this.activeByMeeting.delete(meetingSessionId);
  }

  public async cancelAll(): Promise<void> {
    const sinks = [...this.activeByMeeting.values()].flatMap((meeting) => [...meeting.values()]);
    await Promise.allSettled(sinks.map((sink) => Promise.resolve(sink.cancel('system'))));
    this.activeByMeeting.clear();
  }
}
