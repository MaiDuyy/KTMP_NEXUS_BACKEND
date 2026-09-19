export type VoiceProviderId = 'google' | 'elevenlabs';

export type SttErrorCode =
  | 'VOICE_NO_SPEECH'
  | 'VOICE_STT_TIMEOUT'
  | 'VOICE_STT_UNAVAILABLE'
  | 'VOICE_STT_QUOTA_EXCEEDED'
  | 'VOICE_CANCELLED';

export type TtsErrorCode =
  | 'VOICE_TTS_TIMEOUT'
  | 'VOICE_TTS_UNAVAILABLE'
  | 'VOICE_TTS_QUOTA_EXCEEDED'
  | 'VOICE_CANCELLED'
  | 'VOICE_NO_SPEECH'
  | 'VOICE_SPEECH_TOO_LONG';

export class BatchSttError extends Error {
  public constructor(public readonly code: SttErrorCode) {
    super(code);
    this.name = 'BatchSttError';
  }
}

export class BatchTtsError extends Error {
  public constructor(public readonly code: TtsErrorCode) {
    super(code);
    this.name = 'BatchTtsError';
  }
}

export class StreamingSttError extends Error {
  public constructor(
    public readonly code: Exclude<SttErrorCode, 'VOICE_NO_SPEECH'>,
    public readonly providerCode: string | number | null = null,
    public readonly providerMessage: string | null = null,
  ) {
    super(code);
    this.name = 'StreamingSttError';
  }
}

export class StreamingTtsError extends Error {
  public constructor(
    public readonly code: TtsErrorCode,
    public readonly providerCode: string | number | null = null,
    public readonly providerMessage: string | null = null,
  ) {
    super(code);
    this.name = 'StreamingTtsError';
  }
}

export interface BatchSttResult {
  transcript: string;
  confidence: number | null;
}

export interface BatchSttProvider {
  transcribe(audio: Buffer, mimeType: string, signal?: AbortSignal): Promise<BatchSttResult>;
}

export interface BatchTtsResult {
  audio: Buffer;
  contentType: string;
  encoding: string;
  sampleRateHertz: number;
  channelCount: number;
}

export interface BatchTtsProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<BatchTtsResult>;
}

export interface StreamingSttResult {
  text: string;
  isFinal: boolean;
  stability: number | null;
  confidence: number | null;
  resultEndOffset: string;
}

export interface StreamingSttCallbacks {
  onResult(result: StreamingSttResult): void;
}

export interface StreamingSttSession {
  write(pcm: Buffer): Promise<void>;
  finish(): Promise<void>;
  cancel(): void;
}

export interface StreamingSttProvider {
  open(
    callbacks: StreamingSttCallbacks,
    signal?: AbortSignal,
    phrases?: readonly string[],
  ): StreamingSttSession;
}

export interface StreamingPcmChunk {
  segmentSequence: number;
  audio: Buffer;
  encoding: 'PCM16LE';
  sampleRateHertz: number;
  channelCount: 1;
  receivedAtMs: number;
}

export type StreamingTtsSegmentState =
  | 'SENT_TO_TTS'
  | 'AUDIO_STARTED'
  | 'AUDIO_COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface StreamingTtsSegmentLedgerEntry {
  segmentSequence: number;
  state: StreamingTtsSegmentState;
}

export interface StreamingTtsSession {
  writeSegment(segmentSequence: number, text: string): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
  audio: AsyncIterable<StreamingPcmChunk>;
  getSegmentLedger(): readonly StreamingTtsSegmentLedgerEntry[];
}

export interface StreamingTtsProvider {
  open(signal?: AbortSignal): StreamingTtsSession;
}

export interface SttProviderBundle {
  batch: BatchSttProvider;
  streaming: StreamingSttProvider;
}

export interface TtsProviderBundle {
  batch: BatchTtsProvider;
  streaming: StreamingTtsProvider;
}
