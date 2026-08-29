import type { VoiceErrorCode } from "@ott/shared";
import type { BatchTtsResult } from "../batchTts.js";
import type { VoiceServiceConfig } from "../config.js";
import {
  type ILivekitAdapter,
  type ILivekitAudioSource,
  type ILivekitLocalAudioTrack,
  type ILivekitRoom,
  TrackSource,
} from "./LivekitAdapter.js";
import { LivekitTokenService } from "./LivekitTokenService.js";
import { parseWav } from "../wavParser.js";

export class VoiceError extends Error {
  constructor(public readonly code: VoiceErrorCode, message?: string) {
    super(message || code);
    this.name = "VoiceError";
  }
}

export interface PublishMeetingAudioInput {
  meetingSessionId: string;
  roomName: string;
  turnId: string;
  audio: BatchTtsResult;
  signal?: AbortSignal;
}

export interface PublishMeetingAudioResult {
  meetingSessionId: string;
  roomName: string;
  turnId: string;
  identity: string;
  completed: boolean;
}

interface ParticipantSession {
  room: ILivekitRoom;
  audioSource: ILivekitAudioSource;
  track: ILivekitLocalAudioTrack;
  roomName: string;
  identity: string;
  turnId: string | null;
  completedTurnIds: Set<string>;
  turnPromise: Promise<PublishMeetingAudioResult> | null;
  connectPromise: Promise<void> | null;
  connected: boolean;
  trackPublished: boolean;
  closing: boolean;
  abortController: AbortController | null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  abortSignals: Array<AbortSignal | null | undefined>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signals = abortSignals.filter((signal): signal is AbortSignal => signal !== null && signal !== undefined);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(new VoiceError("VOICE_CANCELLED", "Cancelled")));
    };

    for (const signal of signals) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      finish(() => reject(new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", timeoutMessage)));
    }, timeoutMs);

    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MeetingAudioPublisher {
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, ParticipantSession>();
  private readonly closingSessions = new Map<string, Promise<void>>();

  constructor(
    private readonly config: VoiceServiceConfig,
    private readonly tokenService: LivekitTokenService,
    private readonly adapter: ILivekitAdapter,
  ) {}

  async publish(input: PublishMeetingAudioInput): Promise<PublishMeetingAudioResult> {
    if (this.disposed) {
      throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", "Publisher is disposed");
    }
    if (this.closingSessions.has(input.meetingSessionId)) {
      throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", "Meeting is closing");
    }
    if (!this.config.livekitUrl || !this.config.livekitApiKey || !this.config.livekitApiSecret) {
      throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", "LiveKit credentials missing");
    }
    if (input.signal?.aborted) {
      throw new VoiceError("VOICE_CANCELLED", "Cancelled before publish");
    }

    let session = this.sessions.get(input.meetingSessionId);
    if (session) {
      if (session.closing) {
        throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", "Meeting is closing");
      }
      if (session.roomName !== input.roomName) {
        throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", "Cannot change room name for same meeting");
      }
      if (session.completedTurnIds.has(input.turnId)) {
        return this.completedResult(input, session);
      }
      if (session.turnId === input.turnId && session.turnPromise) {
        return session.turnPromise;
      }
      if (session.turnPromise) {
        throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", "Another turn is currently publishing");
      }
    }

    let parsed: ReturnType<typeof parseWav>;
    try {
      parsed = parseWav(input.audio);
    } catch (error) {
      throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", asError(error).message);
    }

    if (!session) {
      const audioSource = this.adapter.createAudioSource(parsed.sampleRate, parsed.channels);
      session = {
        room: this.adapter.createRoom(),
        audioSource,
        track: audioSource.getTrack(),
        roomName: input.roomName,
        identity: `${input.meetingSessionId}-bot`,
        turnId: null,
        completedTurnIds: new Set<string>(),
        turnPromise: null,
        connectPromise: null,
        connected: false,
        trackPublished: false,
        closing: false,
        abortController: null,
      };
      this.sessions.set(input.meetingSessionId, session);
    }

    session.turnId = input.turnId;
    session.abortController = new AbortController();
    const currentSession = session;
    const turnPromise = this.runTurn(input, currentSession, parsed);
    currentSession.turnPromise = turnPromise;
    return turnPromise;
  }

  private async runTurn(
    input: PublishMeetingAudioInput,
    session: ParticipantSession,
    parsed: ReturnType<typeof parseWav>,
  ): Promise<PublishMeetingAudioResult> {
    try {
      if (!session.connectPromise) {
        session.connectPromise = this.connectAndPublishTrack(input, session);
      }
      await session.connectPromise;
      const result = await this.publishFrames(input, session, parsed.samples, parsed.sampleRate, parsed.channels);

      session.completedTurnIds.add(input.turnId);
      if (session.completedTurnIds.size > 50) {
        const oldestTurnId = session.completedTurnIds.values().next().value;
        if (oldestTurnId !== undefined) session.completedTurnIds.delete(oldestTurnId);
      }
      return result;
    } catch (error) {
      const isTurnCancellation = error instanceof VoiceError && error.code === "VOICE_CANCELLED";
      if ((!session.connected || !isTurnCancellation) && !session.closing) {
        await this.startCleanup(input.meetingSessionId, session, false).catch(() => undefined);
      }
      throw error;
    } finally {
      if (session.turnId === input.turnId) {
        session.turnPromise = null;
        session.abortController = null;
      }
    }
  }

  private async connectAndPublishTrack(input: PublishMeetingAudioInput, session: ParticipantSession): Promise<void> {
    let token: string;
    try {
      token = await this.tokenService.generateToken({
        roomName: input.roomName,
        meetingSessionId: input.meetingSessionId,
      });
    } catch (error) {
      throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", `Token generation failed: ${asError(error).message}`);
    }

    const signals = [input.signal, session.abortController?.signal];
    const connectOperation = session.room.connect(this.config.livekitUrl!, token);
    let connectAbandoned = false;
    void connectOperation.then(
      () => {
        if (connectAbandoned || session.closing) void session.room.disconnect().catch(() => undefined);
      },
      () => undefined,
    );

    try {
      await raceWithAbort(connectOperation, this.config.livekitConnectTimeoutMs, "Connect timeout", signals);
    } catch (error) {
      connectAbandoned = true;
      if (error instanceof VoiceError) throw error;
      throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", `Connect failed: ${asError(error).message}`);
    }

    const publishOperation = session.room.publishTrack(session.track, { source: TrackSource.SOURCE_MICROPHONE });
    let publishAbandoned = false;
    void publishOperation.then(
      () => {
        if (publishAbandoned || session.closing) {
          void session.room.unpublishTrack(session.track).catch(() => undefined);
          void session.room.disconnect().catch(() => undefined);
        }
      },
      () => undefined,
    );

    try {
      await raceWithAbort(publishOperation, this.config.livekitConnectTimeoutMs, "Publish track timeout", signals);
    } catch (error) {
      publishAbandoned = true;
      if (error instanceof VoiceError) throw error;
      throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", `Publish track failed: ${asError(error).message}`);
    }

    session.connected = true;
    session.trackPublished = true;
  }

  private async publishFrames(
    input: PublishMeetingAudioInput,
    session: ParticipantSession,
    pcmData: Int16Array,
    sampleRate: number,
    numChannels: number,
  ): Promise<PublishMeetingAudioResult> {
    const samplesPerFrame = Math.floor(sampleRate * 0.02);
    const signals = [input.signal, session.abortController?.signal];
    const clearQueue = (): void => {
      try {
        session.audioSource.clearQueue();
      } catch {
        // The native source may already be closing.
      }
    };

    for (const signal of signals) {
      if (signal?.aborted) {
        clearQueue();
        throw new VoiceError("VOICE_CANCELLED", "Cancelled before frames");
      }
      signal?.addEventListener("abort", clearQueue, { once: true });
    }

    try {
      for (let offset = 0; offset < pcmData.length;) {
        const frameLength = Math.min(samplesPerFrame, pcmData.length - offset);
        const frameOperation = session.audioSource.captureFrame({
          data: pcmData.subarray(offset, offset + frameLength),
          sampleRate,
          numChannels,
          samplesPerChannel: frameLength,
        });
        await raceWithAbort(frameOperation, this.config.livekitConnectTimeoutMs, "Audio frame timeout", signals);
        offset += frameLength;
      }

      await raceWithAbort(
        session.audioSource.waitForPlayout(),
        this.config.livekitPlayoutTimeoutMs,
        "Playout timeout",
        signals,
      );
      return this.completedResult(input, session);
    } catch (error) {
      clearQueue();
      if (error instanceof VoiceError) throw error;
      throw new VoiceError("VOICE_LIVEKIT_PUBLISH_FAILED", `Publish error: ${asError(error).message}`);
    } finally {
      for (const signal of signals) {
        signal?.removeEventListener("abort", clearQueue);
      }
    }
  }

  private completedResult(input: PublishMeetingAudioInput, session: ParticipantSession): PublishMeetingAudioResult {
    return {
      meetingSessionId: input.meetingSessionId,
      roomName: session.roomName,
      turnId: input.turnId,
      identity: session.identity,
      completed: true,
    };
  }

  async closeMeeting(meetingSessionId: string): Promise<void> {
    const closing = this.closingSessions.get(meetingSessionId);
    if (closing) return closing;
    const session = this.sessions.get(meetingSessionId);
    if (!session) return;
    return this.startCleanup(meetingSessionId, session, true);
  }

  private startCleanup(meetingSessionId: string, session: ParticipantSession, waitForTurn: boolean): Promise<void> {
    const existing = this.closingSessions.get(meetingSessionId);
    if (existing) return existing;

    session.closing = true;
    session.abortController?.abort();
    if (this.sessions.get(meetingSessionId) === session) {
      this.sessions.delete(meetingSessionId);
    }

    const closePromise = this.cleanupSession(session, waitForTurn).finally(() => {
      if (this.closingSessions.get(meetingSessionId) === closePromise) {
        this.closingSessions.delete(meetingSessionId);
      }
    });
    this.closingSessions.set(meetingSessionId, closePromise);
    return closePromise;
  }

  private async cleanupSession(session: ParticipantSession, waitForTurn: boolean): Promise<void> {
    const errors: Error[] = [];
    if (waitForTurn && session.turnPromise) {
      const settled = await settlesWithin(session.turnPromise, this.config.livekitConnectTimeoutMs);
      if (!settled) errors.push(new Error("Active turn cleanup timeout"));
    }

    const attempt = async (operation: () => Promise<void> | void): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(asError(error));
      }
    };

    await attempt(() => session.audioSource.clearQueue());
    if (session.trackPublished) {
      await attempt(() => session.room.unpublishTrack(session.track));
      session.trackPublished = false;
    }
    await attempt(() => session.track.close(false));
    await attempt(() => session.audioSource.close());
    await attempt(() => session.room.disconnect());
    session.connected = false;

    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to clean up LiveKit participant ${session.identity}`);
    }
  }

  async closeAll(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;

    this.disposePromise = (async () => {
      const errors: Error[] = [];
      const meetingClosures = Array.from(this.sessions.keys(), (meetingSessionId) => this.closeMeeting(meetingSessionId));
      const meetingResults = await Promise.allSettled(meetingClosures);
      const pendingResults = await Promise.allSettled(Array.from(this.closingSessions.values()));
      for (const result of [...meetingResults, ...pendingResults]) {
        if (result.status === "rejected") errors.push(asError(result.reason));
      }
      try {
        await this.adapter.dispose();
      } catch (error) {
        errors.push(asError(error));
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to close all LiveKit participants");
      }
    })();

    return this.disposePromise;
  }
}
