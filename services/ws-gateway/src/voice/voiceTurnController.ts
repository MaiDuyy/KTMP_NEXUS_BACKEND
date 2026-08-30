import { randomUUID } from 'node:crypto';
import type {
  VoiceHistoryMessage,
  VoiceErrorCode,
  VoiceLockChangedEvent,
  VoicePipelineContextRequest,
  VoicePipelineContextResponse,
  VoicePipelineEvent,
  VoiceSessionSyncPayload,
  VoiceSessionSyncResponse,
  VoiceStateEvent,
  VoiceTurnCancelPayload,
  VoiceTurnEndPayload,
  VoiceTurnStartPayload,
} from '@ott/shared';
import type { CallRegistryMeta, RedisCallParticipantRegistry } from '../calls/callRegistry.js';
import type { RedisVoiceLockService } from './voiceLockService.js';
import type { VoiceSessionStore } from './voiceSessionStore.js';
import type { VoiceTurnTokenIssuer } from './turnTokenService.js';
import type { VoiceFeaturePolicy } from './voiceFeaturePolicy.js';
import type { VoiceTurnMetrics, VoiceTurnStartOutcome } from './voiceMetrics.js';

const MAX_IDENTIFIER_LENGTH = 256;
const PIPELINE_STATES = new Set(['FINALIZING_STT', 'THINKING', 'RESPONDING']);
const PIPELINE_TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const VOICE_TURN_CANCEL_REASONS = new Set([
  'user_cancelled',
  'call_ended',
  'owner_disconnected',
  'membership_changed',
  'timeout',
  'provider_error',
  'system',
]);

export interface VoiceSocket {
  emit(event: string, payload: unknown): boolean;
  join(room: string): Promise<void> | void;
}

export interface VoiceRoomBroadcaster {
  to(room: string): { emit(event: string, payload: unknown): boolean };
}

export interface VoiceTurnControllerDependencies {
  broadcaster: VoiceRoomBroadcaster;
  callRegistry: RedisCallParticipantRegistry;
  voiceLockService: RedisVoiceLockService;
  voiceSessionStore: VoiceSessionStore;
  tokenIssuer: VoiceTurnTokenIssuer | null;
  voicePublicApiUrl: string;
  featurePolicy?: VoiceFeaturePolicy;
  metrics?: VoiceTurnMetrics;
}

const DEFAULT_FEATURE_POLICY: VoiceFeaturePolicy = {
  enabled: true,
  allowedWorkspaceIds: new Set(),
  isWorkspaceAllowed: () => true,
};

const NOOP_METRICS: VoiceTurnMetrics = {
  recordStart: () => undefined,
  recordTerminal: () => undefined,
};

export interface VoiceTurnRequestContext {
  socket: VoiceSocket;
  userId: string;
  userName: string;
}

export interface VoiceTurnStartRequest extends VoiceTurnRequestContext {
  payload: VoiceTurnStartPayload;
}

export interface VoiceTurnEndRequest extends VoiceTurnRequestContext {
  payload: VoiceTurnEndPayload;
}

export interface VoiceTurnCancelRequest extends VoiceTurnRequestContext {
  payload: VoiceTurnCancelPayload;
}

export interface VoiceSessionSyncRequest extends VoiceTurnRequestContext {
  payload: VoiceSessionSyncPayload;
}

interface AuthorizedMeeting {
  meta: CallRegistryMeta;
  callRoom: string;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function getCallRoom(meetingSessionId: string): string {
  return `call:${meetingSessionId}`;
}

function getVoicePublicUrl(baseUrl: string, turnId: string, suffix: 'audio' | 'stream'): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/voice/turns/${encodeURIComponent(turnId)}/${suffix}`;
  return url.toString();
}

function emitError(
  socket: VoiceSocket,
  meetingSessionId: string,
  turnId: string | null,
  code: VoiceErrorCode,
  message: string,
  retryable: boolean,
): void {
  socket.emit('voice:error', { meetingSessionId, turnId, code, message, retryable });
}

function emitLockChanged(
  broadcaster: VoiceRoomBroadcaster,
  callRoom: string,
  event: VoiceLockChangedEvent,
): void {
  broadcaster.to(callRoom).emit('voice:lock:changed', event);
}

function emitState(
  broadcaster: VoiceRoomBroadcaster,
  callRoom: string,
  meetingSessionId: string,
  turnId: string,
  state: VoiceStateEvent['state'],
): void {
  broadcaster.to(callRoom).emit('voice:state', {
    meetingSessionId,
    turnId,
    state,
    timestamp: new Date().toISOString(),
  } satisfies VoiceStateEvent);
}

/**
 * Authorization and state transition control plane for a single AI voice turn.
 * It intentionally does not accept audio or invoke providers.
 */
export class VoiceTurnController {
  public constructor(private readonly dependencies: VoiceTurnControllerDependencies) {}

  public async start(request: VoiceTurnStartRequest): Promise<void> {
    const { payload, socket, userId, userName } = request;
    const startedAt = performance.now();
    const recordStart = (outcome: VoiceTurnStartOutcome): void => {
      this.metrics.recordStart(outcome, (performance.now() - startedAt) / 1000);
    };
    if (!this.isValidStartPayload(payload)) {
      emitError(socket, this.getMeetingSessionId(payload), null, 'VOICE_INTERNAL_ERROR', 'Yêu cầu AI Voice không hợp lệ.', false);
      recordStart('invalid');
      return;
    }

    const authorized = await this.authorizeMember(socket, userId, payload.meetingSessionId, payload.chatId);
    if (!authorized) {
      recordStart('unauthorized');
      return;
    }
    if (!authorized.meta.workspaceId || authorized.meta.workspaceId !== payload.workspaceId) {
      emitError(socket, payload.meetingSessionId, null, 'VOICE_NOT_IN_CALL', 'Ngữ cảnh workspace của cuộc họp không khớp.', false);
      recordStart('unauthorized');
      return;
    }

    if (!this.featurePolicy.isWorkspaceAllowed(payload.workspaceId)) {
      emitError(socket, payload.meetingSessionId, null, 'VOICE_FEATURE_DISABLED', 'AI Voice chưa được bật cho workspace này.', false);
      recordStart('feature_disabled');
      return;
    }

    if (!this.dependencies.tokenIssuer) {
      emitError(socket, payload.meetingSessionId, null, 'VOICE_INTERNAL_ERROR', 'AI Voice chưa được cấu hình.', false);
      recordStart('unconfigured');
      return;
    }

    const turnId = randomUUID();
    const lock = await this.dependencies.voiceLockService.acquire(payload.meetingSessionId, turnId, userId);
    if (!lock) {
      const owner = await this.dependencies.voiceLockService.get(payload.meetingSessionId);
      emitError(socket, payload.meetingSessionId, owner?.turnId ?? null, 'VOICE_LOCKED_BY_OTHER', 'Một thành viên khác đang hỏi AI.', true);
      recordStart('locked');
      return;
    }

    try {
      await this.dependencies.voiceSessionStore.activate(payload.meetingSessionId, {
        turnId,
        ownerUserId: userId,
        ownerName: userName,
        state: 'LISTENING',
      });
      const issuedToken = this.dependencies.tokenIssuer.issue({
        userId,
        meetingSessionId: payload.meetingSessionId,
        turnId,
        chatId: authorized.meta.chatId,
      });
      const callRoom = authorized.callRoom;
      emitLockChanged(this.dependencies.broadcaster, callRoom, {
        meetingSessionId: payload.meetingSessionId,
        locked: true,
        turnId,
        ownerUserId: userId,
        ownerName: userName,
        state: 'LISTENING',
      });
      emitState(this.dependencies.broadcaster, callRoom, payload.meetingSessionId, turnId, 'LISTENING');
      socket.emit('voice:turn:accepted', {
        meetingSessionId: payload.meetingSessionId,
        turnId,
        turnToken: issuedToken.token,
        uploadUrl: getVoicePublicUrl(this.dependencies.voicePublicApiUrl, turnId, 'audio'),
        streamUrl: getVoicePublicUrl(this.dependencies.voicePublicApiUrl, turnId, 'stream'),
        expiresAt: issuedToken.expiresAt,
      });
      recordStart('accepted');
    } catch (error) {
      await this.dependencies.voiceLockService.release(lock).catch(() => false);
      await this.dependencies.voiceSessionStore.clearActive(payload.meetingSessionId, turnId, userId).catch(() => false);
      emitError(socket, payload.meetingSessionId, turnId, 'VOICE_INTERNAL_ERROR', 'Không thể khởi tạo lượt AI Voice.', true);
      recordStart('internal_error');
    }
  }

  public async end(request: VoiceTurnEndRequest): Promise<void> {
    const { payload, socket, userId } = request;
    if (!this.isValidEndPayload(payload)) {
      emitError(socket, this.getMeetingSessionId(payload), this.getTurnId(payload), 'VOICE_INTERNAL_ERROR', 'Yêu cầu kết thúc AI Voice không hợp lệ.', false);
      return;
    }

    const authorized = await this.authorizeMember(socket, userId, payload.meetingSessionId);
    if (!authorized) {
      return;
    }

    const owner = await this.dependencies.voiceLockService.get(payload.meetingSessionId);
    if (!owner || owner.turnId !== payload.turnId) {
      emitError(socket, payload.meetingSessionId, payload.turnId, 'VOICE_TURN_EXPIRED', 'Lượt AI Voice không còn hoạt động.', true);
      return;
    }
    if (owner.ownerUserId !== userId) {
      emitError(socket, payload.meetingSessionId, payload.turnId, 'VOICE_TURN_NOT_OWNER', 'Bạn không sở hữu lượt AI Voice này.', false);
      return;
    }

    const updated = await this.dependencies.voiceSessionStore.updateState(
      payload.meetingSessionId,
      payload.turnId,
      userId,
      'FINALIZING_STT',
    );
    if (!updated) {
      emitError(socket, payload.meetingSessionId, payload.turnId, 'VOICE_TURN_EXPIRED', 'Lượt AI Voice không còn hoạt động.', true);
      return;
    }

    // Ending microphone capture is not turn completion. The Voice Service must
    // keep the lock until it finishes STT, AI, and TTS for this turn.
    emitState(this.dependencies.broadcaster, authorized.callRoom, payload.meetingSessionId, payload.turnId, 'FINALIZING_STT');
  }

  public async cancel(request: VoiceTurnCancelRequest): Promise<void> {
    if (!this.isValidCancelPayload(request.payload)) {
      emitError(request.socket, this.getMeetingSessionId(request.payload), this.getTurnId(request.payload), 'VOICE_INTERNAL_ERROR', 'Yêu cầu hủy AI Voice không hợp lệ.', false);
      return;
    }

    await this.finish(request, 'CANCELLED', request.payload.reason);
  }

  public async sync(request: VoiceSessionSyncRequest): Promise<VoiceSessionSyncResponse | null> {
    const meetingSessionId = this.getMeetingSessionId(request.payload);
    const authorized = await this.authorizeMember(request.socket, request.userId, meetingSessionId);
    if (!authorized) {
      return null;
    }
    if (!authorized.meta.workspaceId || !this.featurePolicy.isWorkspaceAllowed(authorized.meta.workspaceId)) {
      emitError(request.socket, meetingSessionId, null, 'VOICE_FEATURE_DISABLED', 'AI Voice chưa được bật cho workspace này.', false);
      return null;
    }

    const [lock, activeTurn, messages] = await Promise.all([
      this.dependencies.voiceLockService.get(meetingSessionId),
      this.dependencies.voiceSessionStore.getActive(meetingSessionId),
      this.dependencies.voiceSessionStore.getHistory(meetingSessionId),
    ]);
    const currentTurn = lock && activeTurn &&
      lock.turnId === activeTurn.turnId &&
      lock.ownerUserId === activeTurn.ownerUserId
      ? activeTurn
      : null;

    return {
      meetingSessionId,
      sessionState: 'READY',
      activeTurn: currentTurn,
      messages,
    };
  }

  public async getPipelineContext(
    request: VoicePipelineContextRequest,
  ): Promise<VoicePipelineContextResponse | null> {
    if (
      !isIdentifier(request.meetingSessionId) ||
      !isIdentifier(request.turnId) ||
      !isIdentifier(request.ownerUserId)
    ) {
      return null;
    }

    const [meta, owner, activeTurn] = await Promise.all([
      this.dependencies.callRegistry.getMeta(request.meetingSessionId),
      this.dependencies.voiceLockService.get(request.meetingSessionId),
      this.dependencies.voiceSessionStore.getActive(request.meetingSessionId),
    ]);
    if (
      !meta || meta.status !== 'active' || !meta.workspaceId ||
      !owner || owner.turnId !== request.turnId || owner.ownerUserId !== request.ownerUserId ||
      !activeTurn || activeTurn.turnId !== request.turnId || activeTurn.ownerUserId !== request.ownerUserId
    ) {
      return null;
    }

    const participantIds = await this.dependencies.callRegistry.getParticipantIds(request.meetingSessionId);
    if (!participantIds.includes(request.ownerUserId)) {
      return null;
    }

    return {
      meetingSessionId: request.meetingSessionId,
      turnId: request.turnId,
      ownerUserId: request.ownerUserId,
      ownerName: activeTurn.ownerName,
      roomName: meta.roomName,
      chatId: meta.chatId,
      workspaceId: meta.workspaceId,
      participantIds,
    };
  }

  public async handlePipelineEvent(event: VoicePipelineEvent): Promise<boolean> {
    if (
      !isIdentifier(event.meetingSessionId) ||
      !isIdentifier(event.turnId) ||
      !isIdentifier(event.ownerUserId)
    ) {
      return false;
    }
    if (
      (event.kind === 'state' && !PIPELINE_STATES.has(event.state)) ||
      (event.kind === 'terminal' && !PIPELINE_TERMINAL_STATES.has(event.state)) ||
      !['state', 'transcript', 'message', 'terminal'].includes(event.kind)
    ) {
      return false;
    }

    const owner = await this.dependencies.voiceLockService.get(event.meetingSessionId);
    if (!owner || owner.turnId !== event.turnId || owner.ownerUserId !== event.ownerUserId) {
      return false;
    }

    const callRoom = getCallRoom(event.meetingSessionId);
    if (event.kind === 'state') {
      const refreshed = await this.dependencies.voiceLockService.refreshByOwner(
        event.meetingSessionId,
        event.turnId,
        event.ownerUserId,
      );
      const updated = refreshed && await this.dependencies.voiceSessionStore.updateState(
        event.meetingSessionId,
        event.turnId,
        event.ownerUserId,
        event.state,
      );
      if (!updated) return false;
      emitState(this.dependencies.broadcaster, callRoom, event.meetingSessionId, event.turnId, event.state);
      return true;
    }

    if (event.kind === 'transcript') {
      const activeTurn = await this.dependencies.voiceSessionStore.getActive(event.meetingSessionId);
      if (!activeTurn || activeTurn.turnId !== event.turnId || activeTurn.ownerUserId !== event.ownerUserId) {
        return false;
      }
      const text = event.text.trim();
      if (!text || text.length > 20_000) return false;
      const message: VoiceHistoryMessage = {
        id: `${event.turnId}:user`,
        turnId: event.turnId,
        role: 'user',
        speakerUserId: event.ownerUserId,
        speakerName: activeTurn.ownerName,
        displayText: text,
        createdAt: new Date().toISOString(),
        status: 'COMPLETED',
      };
      if (!await this.dependencies.voiceSessionStore.appendHistory(
        event.meetingSessionId,
        event.turnId,
        event.ownerUserId,
        message,
      )) return false;
      this.dependencies.broadcaster.to(callRoom).emit('voice:transcript', {
        meetingSessionId: event.meetingSessionId,
        turnId: event.turnId,
        speakerUserId: event.ownerUserId,
        speakerName: activeTurn.ownerName,
        text,
        isFinal: true,
        ...(event.confidence === null ? {} : { stability: event.confidence }),
      });
      return true;
    }

    if (event.kind === 'message') {
      const displayText = event.displayText.trim();
      if (!displayText || displayText.length > 20_000) return false;
      const message: VoiceHistoryMessage = {
        id: `${event.turnId}:assistant`,
        turnId: event.turnId,
        role: 'assistant',
        speakerUserId: null,
        speakerName: 'Nexus AI',
        displayText,
        createdAt: new Date().toISOString(),
        status: 'COMPLETED',
      };
      if (!await this.dependencies.voiceSessionStore.appendHistory(
        event.meetingSessionId,
        event.turnId,
        event.ownerUserId,
        message,
      )) return false;
      this.dependencies.broadcaster.to(callRoom).emit('voice:message', {
        meetingSessionId: event.meetingSessionId,
        turnId: event.turnId,
        role: 'assistant',
        displayText,
        isFinal: true,
        sources: Array.isArray(event.sources) ? event.sources.slice(0, 20) : [],
      });
      return true;
    }

    if (event.kind === 'terminal') {
      return this.finishPipelineTurn(event, callRoom);
    }
    return false;
  }

  private async finishPipelineTurn(
    event: Extract<VoicePipelineEvent, { kind: 'terminal' }>,
    callRoom: string,
  ): Promise<boolean> {
    const released = await this.dependencies.voiceLockService.releaseByOwner(
      event.meetingSessionId,
      event.turnId,
      event.ownerUserId,
    );
    if (!released) return false;

    await this.dependencies.voiceSessionStore.updateState(
      event.meetingSessionId,
      event.turnId,
      event.ownerUserId,
      event.state,
    );
    await this.dependencies.voiceSessionStore.clearActive(
      event.meetingSessionId,
      event.turnId,
      event.ownerUserId,
    );
    emitState(this.dependencies.broadcaster, callRoom, event.meetingSessionId, event.turnId, event.state);
    if (event.state === 'FAILED') {
      this.dependencies.broadcaster.to(callRoom).emit('voice:error', {
        meetingSessionId: event.meetingSessionId,
        turnId: event.turnId,
        code: event.code ?? 'VOICE_INTERNAL_ERROR',
        message: event.message ?? 'Không thể hoàn tất lượt AI Voice.',
        retryable: event.retryable ?? true,
      });
    }
    emitLockChanged(this.dependencies.broadcaster, callRoom, {
      meetingSessionId: event.meetingSessionId,
      locked: false,
      turnId: null,
      ownerUserId: null,
      ownerName: null,
      state: 'IDLE',
    });
    this.dependencies.broadcaster.to(callRoom).emit('voice:ready', {
      meetingSessionId: event.meetingSessionId,
      completedTurnId: event.turnId,
    });
    this.metrics.recordTerminal(event.state);
    return true;
  }

  public async cancelForCallCleanup(meetingSessionId: string): Promise<void> {
    if (!isIdentifier(meetingSessionId)) {
      return;
    }

    const owner = await this.dependencies.voiceLockService.get(meetingSessionId);
    const callRoom = getCallRoom(meetingSessionId);
    if (owner) {
      const released = await this.dependencies.voiceLockService.releaseByOwner(
        meetingSessionId,
        owner.turnId,
        owner.ownerUserId,
      );
      if (released) {
        await this.dependencies.voiceSessionStore.updateState(
          meetingSessionId,
          owner.turnId,
          owner.ownerUserId,
          'CANCELLED',
        );
        emitState(this.dependencies.broadcaster, callRoom, meetingSessionId, owner.turnId, 'CANCELLED');
        emitLockChanged(this.dependencies.broadcaster, callRoom, {
          meetingSessionId,
          locked: false,
          turnId: null,
          ownerUserId: null,
          ownerName: null,
          state: 'IDLE',
        });
        this.metrics.recordTerminal('CANCELLED');
      }
    }
    await this.dependencies.voiceSessionStore.clearSession(meetingSessionId);
  }

  public async cancelForParticipantDeparture(meetingSessionId: string, userId: string): Promise<void> {
    if (!isIdentifier(meetingSessionId) || !isIdentifier(userId)) {
      return;
    }

    const owner = await this.dependencies.voiceLockService.get(meetingSessionId);
    if (!owner || owner.ownerUserId !== userId) {
      return;
    }

    await this.finishOwnedTurn(meetingSessionId, owner.turnId, userId, 'CANCELLED');
  }

  private async finish(
    request: VoiceTurnCancelRequest,
    state: 'CANCELLED',
    _reason: string,
  ): Promise<void> {
    const { payload, socket, userId } = request;
    if (!this.isValidEndPayload(payload)) {
      emitError(socket, this.getMeetingSessionId(payload), this.getTurnId(payload), 'VOICE_INTERNAL_ERROR', 'Yêu cầu kết thúc AI Voice không hợp lệ.', false);
      return;
    }

    const authorized = await this.authorizeMember(socket, userId, payload.meetingSessionId);
    if (!authorized) {
      return;
    }

    const owner = await this.dependencies.voiceLockService.get(payload.meetingSessionId);
    if (!owner || owner.turnId !== payload.turnId) {
      emitError(socket, payload.meetingSessionId, payload.turnId, 'VOICE_TURN_EXPIRED', 'Lượt AI Voice không còn hoạt động.', true);
      return;
    }
    if (owner.ownerUserId !== userId) {
      emitError(socket, payload.meetingSessionId, payload.turnId, 'VOICE_TURN_NOT_OWNER', 'Bạn không sở hữu lượt AI Voice này.', false);
      return;
    }

    await this.finishOwnedTurn(payload.meetingSessionId, payload.turnId, userId, state, authorized.callRoom);
  }

  private async finishOwnedTurn(
    meetingSessionId: string,
    turnId: string,
    userId: string,
    state: 'COMPLETED' | 'CANCELLED',
    callRoom: string = getCallRoom(meetingSessionId),
  ): Promise<void> {
    const released = await this.dependencies.voiceLockService.releaseByOwner(meetingSessionId, turnId, userId);
    if (!released) {
      return;
    }

    await this.dependencies.voiceSessionStore.updateState(meetingSessionId, turnId, userId, state);
    await this.dependencies.voiceSessionStore.clearActive(meetingSessionId, turnId, userId);

    emitState(this.dependencies.broadcaster, callRoom, meetingSessionId, turnId, state);
    emitLockChanged(this.dependencies.broadcaster, callRoom, {
      meetingSessionId,
      locked: false,
      turnId: null,
      ownerUserId: null,
      ownerName: null,
      state: 'IDLE',
    });
    this.dependencies.broadcaster.to(callRoom).emit('voice:ready', { meetingSessionId, completedTurnId: turnId });
    this.metrics.recordTerminal(state);
  }

  private get featurePolicy(): VoiceFeaturePolicy {
    return this.dependencies.featurePolicy ?? DEFAULT_FEATURE_POLICY;
  }

  private get metrics(): VoiceTurnMetrics {
    return this.dependencies.metrics ?? NOOP_METRICS;
  }

  private async authorizeMember(
    socket: VoiceSocket,
    userId: string,
    meetingSessionId: string,
    expectedChatId?: string,
  ): Promise<AuthorizedMeeting | null> {
    if (!isIdentifier(meetingSessionId) || !isIdentifier(userId)) {
      emitError(socket, this.getMeetingSessionId({ meetingSessionId }), null, 'VOICE_MEETING_NOT_ACTIVE', 'Cuộc gọi không hợp lệ.', false);
      return null;
    }

    const meta = await this.dependencies.callRegistry.getMeta(meetingSessionId);
    if (!meta || meta.status !== 'active') {
      emitError(socket, meetingSessionId, null, 'VOICE_MEETING_NOT_ACTIVE', 'Cuộc gọi không còn hoạt động.', true);
      return null;
    }
    if (expectedChatId !== undefined && expectedChatId !== meta.chatId) {
      emitError(socket, meetingSessionId, null, 'VOICE_NOT_IN_CALL', 'Ngữ cảnh cuộc họp không khớp.', false);
      return null;
    }
    if (!(await this.dependencies.callRegistry.hasParticipant(meetingSessionId, userId))) {
      emitError(socket, meetingSessionId, null, 'VOICE_NOT_IN_CALL', 'Bạn không ở trong cuộc gọi này.', false);
      return null;
    }

    const callRoom = getCallRoom(meetingSessionId);
    await socket.join(callRoom);
    return { meta, callRoom };
  }

  private isValidStartPayload(payload: unknown): payload is VoiceTurnStartPayload {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const value = payload as VoiceTurnStartPayload;
    return (
      isIdentifier(value.meetingSessionId) &&
      isIdentifier(value.chatId) &&
      isIdentifier(value.workspaceId) &&
      isIdentifier(value.clientRequestId) &&
      value.mode === 'rag'
    );
  }

  private isValidEndPayload(payload: unknown): payload is VoiceTurnEndPayload {
    return (
      !!payload &&
      typeof payload === 'object' &&
      isIdentifier((payload as VoiceTurnEndPayload).meetingSessionId) &&
      isIdentifier((payload as VoiceTurnEndPayload).turnId)
    );
  }

  private isValidCancelPayload(payload: unknown): payload is VoiceTurnCancelPayload {
    return (
      this.isValidEndPayload(payload) &&
      VOICE_TURN_CANCEL_REASONS.has((payload as VoiceTurnCancelPayload).reason)
    );
  }

  private getMeetingSessionId(payload: unknown): string {
    return (
      !!payload &&
      typeof payload === 'object' &&
      isIdentifier((payload as { meetingSessionId?: unknown }).meetingSessionId)
    )
      ? (payload as { meetingSessionId: string }).meetingSessionId
      : '';
  }

  private getTurnId(payload: unknown): string | null {
    return (
      !!payload &&
      typeof payload === 'object' &&
      isIdentifier((payload as { turnId?: unknown }).turnId)
    )
      ? (payload as { turnId: string }).turnId
      : null;
  }
}
