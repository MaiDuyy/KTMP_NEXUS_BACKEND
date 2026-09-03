import type { MeetingAiStreamEvent } from '@ott/shared';
import type { StreamingMeetingAudioSession, StreamingPublishSummary } from '../livekit/StreamingMeetingAudioPublisher.js';
import { SentenceBoundaryBuffer, type SpeechSegment } from './sentenceBoundaryBuffer.js';
import type { StreamingPcmChunk, StreamingTtsSession } from './googleStreamingTts.js';

export interface StreamingOutputPublisher {
  start(input: {
    meetingSessionId: string;
    roomName: string;
    turnId: string;
    signal?: AbortSignal;
    onFirstFrame?: () => void;
  }): Promise<StreamingMeetingAudioSession>;
  closeMeeting?(meetingSessionId: string): Promise<void>;
}

export interface StreamingOutputTtsProvider {
  open(signal?: AbortSignal): StreamingTtsSession;
}

export interface StreamingOutputInput {
  meetingSessionId: string;
  roomName: string;
  turnId: string;
  events: AsyncIterable<MeetingAiStreamEvent>;
  signal?: AbortSignal;
  onFirstFrame?: () => void;
  onSideChannelEvent?: (event: Extract<MeetingAiStreamEvent, { type: 'display.delta' | 'source' }>) => void | Promise<void>;
}

export interface StreamingOutputSummary {
  speechDeltaCount: number;
  audioChunkCount: number;
  audio: StreamingPublishSummary;
  startedAtMonotonicMs: number;
  firstAudioAtMonotonicMs: number | null;
  firstFrameAtMonotonicMs: number | null;
  aiDoneAtMonotonicMs: number;
  ttsDoneAtMonotonicMs: number;
  playoutCompletedAtMonotonicMs: number;
}

export class StreamingOutputError extends Error {
  public constructor(
    public readonly aiDone: boolean,
    public readonly firstFramePublished: boolean,
    public readonly fallbackSpeechText: string,
  ) { super('VOICE_STREAMING_OUTPUT_FAILED'); }
}

/**
 * Connects already-validated typed SSE to speech only. Display/source events
 * remain available to the caller but never enter the audio path.
 */
export class StreamingOutputOrchestrator {
  public constructor(
    private readonly tts: StreamingOutputTtsProvider,
    private readonly publisher: StreamingOutputPublisher,
    private readonly sentenceConfig: Omit<ConstructorParameters<typeof SentenceBoundaryBuffer>[0]['config'], 'maximumBytes'> & { maximumBytes: number },
  ) {}

  public async run(input: StreamingOutputInput): Promise<StreamingOutputSummary> {
    if (input.signal?.aborted) throw new Error('VOICE_CANCELLED');
    const startedAtMonotonicMs = performance.now();
    let firstAudioAtMonotonicMs: number | null = null;
    let firstFrameAtMonotonicMs: number | null = null;
    let aiDoneAtMonotonicMs = 0;
    let ttsDoneAtMonotonicMs = 0;
    let firstFramePublished = false;
    let fallbackSpeechText = '';
    const publishSession = await this.publisher.start({
      meetingSessionId: input.meetingSessionId,
      roomName: input.roomName,
      turnId: input.turnId,
      signal: input.signal,
      onFirstFrame: () => { firstFramePublished = true; firstFrameAtMonotonicMs ??= performance.now(); input.onFirstFrame?.(); },
    });
    const ttsSession = this.tts.open(input.signal);
    let audioChunkCount = 0;
    let streamingFailure: unknown = null;
    const consumeAudio = (async () => {
      try {
        for await (const chunk of ttsSession.audio) {
          audioChunkCount += 1;
          firstAudioAtMonotonicMs ??= performance.now();
          await publishSession.write(chunk);
        }
      } catch (error) {
        streamingFailure ??= error;
      }
    })();
    const sentenceBuffer = new SentenceBoundaryBuffer({
      turnId: input.turnId,
      config: this.sentenceConfig,
      signal: input.signal,
      onSegment: async (segment: SpeechSegment) => {
        if (streamingFailure) return;
        try {
          await ttsSession.writeSegment(segment.segmentSequence, segment.text);
        } catch (error) {
          streamingFailure ??= error;
          await ttsSession.cancel().catch(() => undefined);
        }
      },
    });
    let done = false;
    let speechDeltaCount = 0;
    try {
      for await (const event of input.events) {
        if (event.turnId !== input.turnId || done) throw new Error('VOICE_AI_UNAVAILABLE');
        if (event.type === 'speech.delta') {
          speechDeltaCount += 1;
          fallbackSpeechText += event.text;
          await sentenceBuffer.push({ turnId: event.turnId, sequence: event.sequence, text: event.text });
          continue;
        }
        if (event.type === 'display.delta' || event.type === 'source') {
          await input.onSideChannelEvent?.(event);
          continue;
        }
        if (event.type === 'done') { done = true; aiDoneAtMonotonicMs = performance.now(); }
      }
      if (!done) throw new Error('VOICE_AI_UNAVAILABLE');
      await sentenceBuffer.finish();
      if (!streamingFailure) {
        try { await ttsSession.finish(); } catch (error) { streamingFailure ??= error; }
      }
      await consumeAudio;
      if (streamingFailure) {
        await Promise.allSettled([
          ttsSession.cancel(),
          publishSession.cancel(),
          this.publisher.closeMeeting?.(input.meetingSessionId) ?? Promise.resolve(),
        ]);
        throw new StreamingOutputError(done, firstFramePublished, fallbackSpeechText.trim());
      }
      ttsDoneAtMonotonicMs = performance.now();
      const audio = await publishSession.finish();
      if (!firstFramePublished) {
        throw new StreamingOutputError(done, false, fallbackSpeechText.trim());
      }
      const playoutCompletedAtMonotonicMs = performance.now();
      return { speechDeltaCount, audioChunkCount, audio, startedAtMonotonicMs, firstAudioAtMonotonicMs, firstFrameAtMonotonicMs, aiDoneAtMonotonicMs, ttsDoneAtMonotonicMs, playoutCompletedAtMonotonicMs };
    } catch (error) {
      await Promise.allSettled([
        sentenceBuffer.cancel(),
        ttsSession.cancel(),
        publishSession.cancel(),
        consumeAudio,
        this.publisher.closeMeeting?.(input.meetingSessionId) ?? Promise.resolve(),
      ]);
      if (error instanceof StreamingOutputError) throw error;
      if (input.signal?.aborted || (error instanceof Error && error.message === 'VOICE_CANCELLED')) throw error;
      throw new StreamingOutputError(done, firstFramePublished, fallbackSpeechText.trim());
    }
  }
}

export function pcmChunk(sequence: number, audio: Buffer): StreamingPcmChunk {
  return {
    segmentSequence: sequence,
    audio,
    encoding: 'PCM16LE',
    sampleRateHertz: 24_000,
    channelCount: 1,
    receivedAtMs: Date.now(),
  };
}
