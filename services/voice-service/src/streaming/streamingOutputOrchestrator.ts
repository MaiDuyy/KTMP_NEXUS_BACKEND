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
  onSideChannelEvent?: (event: Extract<MeetingAiStreamEvent, { type: 'display.delta' | 'source' }>) => void;
}

export interface StreamingOutputSummary {
  speechDeltaCount: number;
  audioChunkCount: number;
  audio: StreamingPublishSummary;
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
    const publishSession = await this.publisher.start({
      meetingSessionId: input.meetingSessionId,
      roomName: input.roomName,
      turnId: input.turnId,
      signal: input.signal,
      onFirstFrame: input.onFirstFrame,
    });
    const ttsSession = this.tts.open(input.signal);
    let audioChunkCount = 0;
    const consumeAudio = (async () => {
      for await (const chunk of ttsSession.audio) {
        audioChunkCount += 1;
        await publishSession.write(chunk);
      }
    })();
    const sentenceBuffer = new SentenceBoundaryBuffer({
      turnId: input.turnId,
      config: this.sentenceConfig,
      signal: input.signal,
      onSegment: (segment: SpeechSegment) => ttsSession.writeSegment(segment.segmentSequence, segment.text),
    });
    let done = false;
    let speechDeltaCount = 0;
    try {
      for await (const event of input.events) {
        if (event.turnId !== input.turnId || done) throw new Error('VOICE_AI_UNAVAILABLE');
        if (event.type === 'speech.delta') {
          speechDeltaCount += 1;
          await sentenceBuffer.push({ turnId: event.turnId, sequence: event.sequence, text: event.text });
          continue;
        }
        if (event.type === 'display.delta' || event.type === 'source') {
          input.onSideChannelEvent?.(event);
          continue;
        }
        if (event.type === 'done') done = true;
      }
      if (!done) throw new Error('VOICE_AI_UNAVAILABLE');
      await sentenceBuffer.finish();
      await ttsSession.finish();
      await consumeAudio;
      const audio = await publishSession.finish();
      return { speechDeltaCount, audioChunkCount, audio };
    } catch (error) {
      await Promise.allSettled([sentenceBuffer.cancel(), ttsSession.cancel(), publishSession.cancel(), consumeAudio]);
      throw error;
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
