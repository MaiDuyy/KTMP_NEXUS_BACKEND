/** Shared contract for the Meeting AI Voice turn lifecycle. */

export type MeetingVoiceSessionState =
  | 'INACTIVE'
  | 'READY'
  | 'ENDING'
  | 'ENDED';

export type VoiceTurnState =
  | 'IDLE'
  | 'LISTENING'
  | 'FINALIZING_STT'
  | 'THINKING'
  | 'RESPONDING'
  | 'COMPLETED'
  | 'CANCELLING'
  | 'FAILED'
  | 'CANCELLED';

export type VoiceTurnMode = 'rag';

export type VoiceTransportMode = 'streaming' | 'batch';

export const VOICE_STREAM_PROTOCOL_VERSION = 1 as const;
export const VOICE_STREAM_AUDIO_FRAME_TYPE = 1 as const;
export const VOICE_STREAM_BINARY_HEADER_BYTES = 6 as const;
export const VOICE_STREAM_SAMPLE_RATE_HZ = 16_000 as const;
export const VOICE_STREAM_CHANNEL_COUNT = 1 as const;
export const VOICE_STREAM_CHUNK_DURATION_MS = 20 as const;
export const VOICE_STREAM_SAMPLES_PER_CHUNK = 320 as const;
export const VOICE_STREAM_PCM_BYTES_PER_CHUNK = 640 as const;
export const VOICE_STREAM_MAX_PCM_PAYLOAD_BYTES = 15_000 as const;
export const MEETING_AI_STREAM_VERSION = 1 as const;

export interface MeetingAiSpeechDeltaEvent {
  type: 'speech.delta';
  version: typeof MEETING_AI_STREAM_VERSION;
  turnId: string;
  sequence: number;
  text: string;
}

export interface MeetingAiDisplayDeltaEvent {
  type: 'display.delta';
  version: typeof MEETING_AI_STREAM_VERSION;
  turnId: string;
  sequence: number;
  text: string;
}

export interface MeetingAiSourceEvent {
  type: 'source';
  version: typeof MEETING_AI_STREAM_VERSION;
  turnId: string;
  sequence: number;
  documentId: string;
  title: string;
  chunkId: string;
}

export interface MeetingAiDoneEvent {
  type: 'done';
  version: typeof MEETING_AI_STREAM_VERSION;
  turnId: string;
  replayed: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  } | null;
  latency?: {
    firstDeltaMs: number;
    totalMs: number;
  } | null;
}

export type MeetingAiStreamEvent =
  | MeetingAiSpeechDeltaEvent
  | MeetingAiDisplayDeltaEvent
  | MeetingAiSourceEvent
  | MeetingAiDoneEvent;

export interface VoiceStreamingAudioFormat {
  encoding: 'LINEAR16';
  sampleRateHz: typeof VOICE_STREAM_SAMPLE_RATE_HZ;
  channelCount: typeof VOICE_STREAM_CHANNEL_COUNT;
  chunkDurationMs: typeof VOICE_STREAM_CHUNK_DURATION_MS;
}

export interface VoiceStreamDescriptor {
  protocolVersion: typeof VOICE_STREAM_PROTOCOL_VERSION;
  audioFormat: VoiceStreamingAudioFormat;
  authTimeoutMs: number;
  maxQueuedBytes: number;
}

export interface VoiceStreamAuthFrame {
  type: 'auth';
  protocolVersion: typeof VOICE_STREAM_PROTOCOL_VERSION;
  turnId: string;
  turnToken: string;
}

export interface VoiceStreamEndFrame {
  type: 'end';
  finalSequence: number | null;
}

export interface VoiceStreamCancelFrame {
  type: 'cancel';
  reason: VoiceTurnCancelReason;
}

export type VoiceStreamClientFrame =
  | VoiceStreamAuthFrame
  | VoiceStreamEndFrame
  | VoiceStreamCancelFrame;

export interface VoiceStreamReadyFrame {
  type: 'ready';
  protocolVersion: typeof VOICE_STREAM_PROTOCOL_VERSION;
  audioFormat: VoiceStreamingAudioFormat;
  maxQueuedBytes: number;
}

export interface VoiceStreamAckFrame {
  type: 'ack';
  sequence: number;
  queuedBytes: number;
}

export interface VoiceStreamFinalizedFrame {
  type: 'finalized';
  finalSequence: number | null;
}

export interface VoiceStreamErrorFrame {
  type: 'error';
  code: VoiceErrorCode;
  message: string;
  retryable: boolean;
}

export type VoiceStreamServerFrame =
  | VoiceStreamReadyFrame
  | VoiceStreamAckFrame
  | VoiceStreamFinalizedFrame
  | VoiceStreamErrorFrame;

export type VoiceMessageRole = 'user' | 'assistant';

export type VoiceTurnCancelReason =
  | 'user_cancelled'
  | 'call_ended'
  | 'owner_disconnected'
  | 'membership_changed'
  | 'timeout'
  | 'provider_error'
  | 'system';

export type VoiceErrorCode =
  | 'VOICE_FEATURE_DISABLED'
  | 'VOICE_NOT_IN_CALL'
  | 'VOICE_MEETING_NOT_ACTIVE'
  | 'VOICE_MEETING_ENDING'
  | 'VOICE_LOCKED_BY_OTHER'
  | 'VOICE_TURN_NOT_OWNER'
  | 'VOICE_TURN_EXPIRED'
  | 'VOICE_TOKEN_INVALID'
  | 'VOICE_STREAM_PROTOCOL_ERROR'
  | 'VOICE_STREAM_AUTH_TIMEOUT'
  | 'VOICE_STREAM_SEQUENCE_ERROR'
  | 'VOICE_STREAM_BACKPRESSURE'
  | 'VOICE_STREAM_DISCONNECTED'
  | 'VOICE_STREAM_TIMEOUT'
  | 'VOICE_AUDIO_FORMAT_UNSUPPORTED'
  | 'VOICE_AUDIO_TOO_LARGE'
  | 'VOICE_SPEECH_TOO_LONG'
  | 'VOICE_NO_SPEECH'
  | 'VOICE_STT_TIMEOUT'
  | 'VOICE_STT_UNAVAILABLE'
  | 'VOICE_AI_TIMEOUT'
  | 'VOICE_AI_UNAVAILABLE'
  | 'VOICE_TTS_TIMEOUT'
  | 'VOICE_TTS_UNAVAILABLE'
  | 'VOICE_LIVEKIT_PUBLISH_FAILED'
  | 'VOICE_CANCELLED'
  | 'VOICE_INTERNAL_ERROR';

export interface VoiceMeetingContext {
  meetingSessionId: string;
  chatId: string;
  workspaceId: string;
}

export interface VoiceTurnStartPayload extends VoiceMeetingContext {
  clientRequestId: string;
  mode: VoiceTurnMode;
  transportMode?: VoiceTransportMode;
}

export interface VoiceTurnEndPayload {
  meetingSessionId: string;
  turnId: string;
}

export interface VoiceTurnCancelPayload extends VoiceTurnEndPayload {
  reason: VoiceTurnCancelReason;
}

export interface VoiceTurnAcceptedEvent {
  meetingSessionId: string;
  turnId: string;
  turnToken: string;
  uploadUrl: string;
  streamUrl: string;
  stream?: VoiceStreamDescriptor;
  expiresAt: string;
}

export interface VoiceLockChangedEvent {
  meetingSessionId: string;
  locked: boolean;
  turnId: string | null;
  completedTurnId?: string;
  ownerUserId: string | null;
  ownerName: string | null;
  state: VoiceTurnState;
}

export interface VoiceStateEvent {
  meetingSessionId: string;
  turnId: string;
  state: VoiceTurnState;
  timestamp: string;
}

export interface VoiceTranscriptEvent {
  meetingSessionId: string;
  turnId: string;
  speakerUserId: string;
  speakerName: string;
  text: string;
  isFinal: boolean;
  stability?: number;
  revision?: number;
}

export interface VoiceMessageEvent {
  meetingSessionId: string;
  turnId: string;
  role: 'assistant';
  displayText: string;
  isFinal: boolean;
  revision?: number;
  sources: VoiceMessageSource[];
}

export interface VoiceMessageSource {
  documentId: string | number;
  title: string;
  chunkId: string;
}

export interface VoiceReadyEvent {
  meetingSessionId: string;
  completedTurnId: string;
}

export interface VoiceErrorEvent {
  meetingSessionId: string;
  turnId: string | null;
  code: VoiceErrorCode;
  message: string;
  retryable: boolean;
}

export interface VoiceActiveTurn {
  turnId: string;
  ownerUserId: string;
  ownerName: string;
  state: VoiceTurnState;
}

export interface VoiceHistoryMessage {
  id: string;
  turnId: string;
  role: VoiceMessageRole;
  speakerUserId: string | null;
  speakerName: string | null;
  displayText: string;
  createdAt: string;
  status: 'STREAMING' | 'COMPLETED' | 'FAILED';
}

export interface VoiceSessionSyncPayload {
  meetingSessionId: string;
}

export interface VoiceSessionSyncResponse {
  meetingSessionId: string;
  sessionState: MeetingVoiceSessionState;
  activeTurn: VoiceActiveTurn | null;
  messages: VoiceHistoryMessage[];
}

export interface VoicePipelineContextRequest {
  meetingSessionId: string;
  turnId: string;
  ownerUserId: string;
}

export interface VoicePipelineContextResponse extends VoiceMeetingContext {
  turnId: string;
  ownerUserId: string;
  ownerName: string;
  roomName: string;
  participantIds: string[];
}

interface VoicePipelineEventBase {
  meetingSessionId: string;
  turnId: string;
  ownerUserId: string;
}

export interface VoicePipelineStateEvent extends VoicePipelineEventBase {
  kind: 'state';
  state: 'FINALIZING_STT' | 'THINKING' | 'RESPONDING';
}

export interface VoicePipelineTranscriptEvent extends VoicePipelineEventBase {
  kind: 'transcript';
  speakerName: string;
  text: string;
  confidence: number | null;
}

export interface VoicePipelinePartialTranscriptEvent extends VoicePipelineEventBase {
  kind: 'transcript_partial';
  speakerName: string;
  text: string;
  stability: number | null;
  revision: number;
}

export interface VoicePipelineMessageEvent extends VoicePipelineEventBase {
  kind: 'message';
  displayText: string;
  sources: VoiceMessageSource[];
}

/** A transient assistant display update. It is never persisted as history. */
export interface VoicePipelinePartialMessageEvent extends VoicePipelineEventBase {
  kind: 'message_partial';
  displayText: string;
  revision: number;
  sources: VoiceMessageSource[];
}

export interface VoicePipelineTerminalEvent extends VoicePipelineEventBase {
  kind: 'terminal';
  state: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  code?: VoiceErrorCode;
  message?: string;
  retryable?: boolean;
}

export type VoicePipelineEvent =
  | VoicePipelineStateEvent
  | VoicePipelinePartialTranscriptEvent
  | VoicePipelineTranscriptEvent
  | VoicePipelinePartialMessageEvent
  | VoicePipelineMessageEvent
  | VoicePipelineTerminalEvent;

export interface MeetingVoiceClientToServerEvents {
  'voice:turn:start': (payload: VoiceTurnStartPayload) => void;
  'voice:turn:end': (payload: VoiceTurnEndPayload) => void;
  'voice:turn:cancel': (payload: VoiceTurnCancelPayload) => void;
  'voice:session:sync': (
    payload: VoiceSessionSyncPayload,
    acknowledge?: (response: VoiceSessionSyncResponse) => void,
  ) => void;
}

export interface MeetingVoiceServerToClientEvents {
  'voice:turn:accepted': (event: VoiceTurnAcceptedEvent) => void;
  'voice:lock:changed': (event: VoiceLockChangedEvent) => void;
  'voice:state': (event: VoiceStateEvent) => void;
  'voice:transcript': (event: VoiceTranscriptEvent) => void;
  'voice:message': (event: VoiceMessageEvent) => void;
  'voice:ready': (event: VoiceReadyEvent) => void;
  'voice:error': (event: VoiceErrorEvent) => void;
}
