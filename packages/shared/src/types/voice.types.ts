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
  | 'VOICE_NOT_IN_CALL'
  | 'VOICE_MEETING_NOT_ACTIVE'
  | 'VOICE_MEETING_ENDING'
  | 'VOICE_LOCKED_BY_OTHER'
  | 'VOICE_TURN_NOT_OWNER'
  | 'VOICE_TURN_EXPIRED'
  | 'VOICE_TOKEN_INVALID'
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
  expiresAt: string;
}

export interface VoiceLockChangedEvent {
  meetingSessionId: string;
  locked: boolean;
  turnId: string | null;
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
}

export interface VoiceMessageEvent {
  meetingSessionId: string;
  turnId: string;
  role: 'assistant';
  displayText: string;
  isFinal: boolean;
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

export interface VoicePipelineMessageEvent extends VoicePipelineEventBase {
  kind: 'message';
  displayText: string;
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
  | VoicePipelineTranscriptEvent
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
