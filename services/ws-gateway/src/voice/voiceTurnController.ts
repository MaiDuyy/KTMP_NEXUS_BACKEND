import { randomUUID } from 'node:crypto';
import type {
  VoiceErrorCode,
  VoiceLockChangedEvent,
  VoiceStateEvent,
  VoiceTurnCancelPayload,
  VoiceTurnEndPayload,
  VoiceTurnStartPayload,
} from '@ott/shared';
import type { CallRegistryMeta, RedisCallParticipantRegistry } from '../calls/callRegistry.js';
import type { RedisVoiceLockService } from './voiceLockService.js';
import type { VoiceTurnTokenIssuer } from './turnTokenService.js';

const MAX_IDENTIFIER_LENGTH = 256;
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
  tokenIssuer: VoiceTurnTokenIssuer | null;
  voiceServicePublicUrl: string;
}

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

function getVoiceServiceUrl(baseUrl: string, turnId: string, suffix: 'audio' | 'stream'): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/voice/turns/${encodeURIComponent(turnId)}/${suffix}`;
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
    if (!this.isValidStartPayload(payload)) {
      emitError(socket, this.getMeetingSessionId(payload), null, 'VOICE_INTERNAL_ERROR', 'Yêu cầu AI Voice không hợp lệ.', false);
      return;
    }

    const authorized = await this.authorizeMember(socket, userId, payload.meetingSessionId, payload.chatId);
    if (!authorized) {
      return;
    }

    if (!this.dependencies.tokenIssuer) {
      emitError(socket, payload.meetingSessionId, null, 'VOICE_INTERNAL_ERROR', 'AI Voice chưa được cấu hình.', false);
      return;
    }

    const turnId = randomUUID();
    const lock = await this.dependencies.voiceLockService.acquire(payload.meetingSessionId, turnId, userId);
    if (!lock) {
      const owner = await this.dependencies.voiceLockService.get(payload.meetingSessionId);
      emitError(socket, payload.meetingSessionId, owner?.turnId ?? null, 'VOICE_LOCKED_BY_OTHER', 'Một thành viên khác đang hỏi AI.', true);
      return;
    }

    try {
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
        uploadUrl: getVoiceServiceUrl(this.dependencies.voiceServicePublicUrl, turnId, 'audio'),
        streamUrl: getVoiceServiceUrl(this.dependencies.voiceServicePublicUrl, turnId, 'stream'),
        expiresAt: issuedToken.expiresAt,
      });
    } catch (error) {
      await this.dependencies.voiceLockService.release(lock).catch(() => false);
      emitError(socket, payload.meetingSessionId, turnId, 'VOICE_INTERNAL_ERROR', 'Không thể khởi tạo lượt AI Voice.', true);
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

  public async cancelForCallCleanup(meetingSessionId: string): Promise<void> {
    if (!isIdentifier(meetingSessionId)) {
      return;
    }

    const owner = await this.dependencies.voiceLockService.get(meetingSessionId);
    if (!owner) {
      return;
    }

    const meta = await this.dependencies.callRegistry.getMeta(meetingSessionId);
    const callRoom = getCallRoom(meetingSessionId);
    await this.dependencies.voiceLockService.releaseByOwner(meetingSessionId, owner.turnId, owner.ownerUserId);
    emitState(this.dependencies.broadcaster, callRoom, meetingSessionId, owner.turnId, 'CANCELLED');
    emitLockChanged(this.dependencies.broadcaster, callRoom, {
      meetingSessionId,
      locked: false,
      turnId: null,
      ownerUserId: null,
      ownerName: null,
      state: 'IDLE',
    });
    this.dependencies.broadcaster.to(callRoom).emit('voice:ready', {
      meetingSessionId,
      completedTurnId: owner.turnId,
    });

    // Meta may have expired while the lock was still alive. The broadcasts above are harmless in that case.
    void meta;
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
