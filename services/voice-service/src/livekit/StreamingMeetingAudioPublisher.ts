import type { VoiceErrorCode } from '@ott/shared';
import type { VoiceServiceConfig } from '../config.js';
import type { StreamingPcmChunk } from '../streaming/googleStreamingTts.js';
import {
  LIVEKIT_SAMPLE_RATE_HERTZ,
  Pcm48kResampler,
  PcmFrameAssembler,
  StreamingPcmError,
  type Pcm48kResamplerSummary,
  type PcmFrameAssemblerSummary,
} from '../streaming/pcm48k.js';
import { TrackSource, type ILivekitAdapter, type ILivekitAudioSource, type ILivekitLocalAudioTrack, type ILivekitRoom } from './LivekitAdapter.js';
import { LivekitTokenService } from './LivekitTokenService.js';

export class StreamingPublishError extends Error {
  public constructor(public readonly code: VoiceErrorCode, message?: string) {
    super(message ?? code);
  }
}

export interface StreamingPublishInput {
  meetingSessionId: string;
  roomName: string;
  turnId: string;
  signal?: AbortSignal;
  onFirstFrame?: () => void;
}

export interface StreamingPublishSummary {
  meetingSessionId: string;
  roomName: string;
  turnId: string;
  identity: string;
  firstFrameAtMs: number | null;
  playoutCompletedAtMs: number;
  resampler: Pcm48kResamplerSummary;
  frames: PcmFrameAssemblerSummary;
}

export interface StreamingMeetingAudioSession {
  write(chunk: StreamingPcmChunk): Promise<void>;
  finish(): Promise<StreamingPublishSummary>;
  cancel(): Promise<void>;
}

interface ParticipantSession {
  room: ILivekitRoom;
  source: ILivekitAudioSource;
  track: ILivekitLocalAudioTrack;
  roomName: string;
  identity: string;
  connecting: Promise<void> | null;
  connected: boolean;
  published: boolean;
  closing: boolean;
}

interface ActiveTurn {
  input: StreamingPublishInput;
  participant: ParticipantSession;
  controller: AbortController;
  resampler: Pcm48kResampler;
  assembler: PcmFrameAssembler;
  terminal: boolean;
  finishPromise: Promise<StreamingPublishSummary> | null;
  firstFrameAtMs: number | null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function toPublishError(error: unknown): StreamingPublishError {
  if (error instanceof StreamingPublishError) return error;
  if (error instanceof StreamingPcmError) return new StreamingPublishError(error.code, error.message);
  return new StreamingPublishError('VOICE_LIVEKIT_PUBLISH_FAILED', asError(error).message);
}

async function raceWithAbort<T>(operation: Promise<T>, timeoutMs: number, signals: readonly (AbortSignal | undefined)[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeSignals.forEach((signal) => signal.removeEventListener('abort', onAbort));
      callback();
    };
    const onAbort = () => finish(() => reject(new StreamingPublishError('VOICE_CANCELLED')));
    const timer = setTimeout(() => finish(() => reject(new StreamingPublishError('VOICE_LIVEKIT_PUBLISH_FAILED', 'LiveKit operation timeout'))), timeoutMs);
    for (const signal of activeSignals) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    operation.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

/** Incremental 48 kHz LiveKit publisher. It is intentionally separate from the Phase 1 WAV batch publisher. */
export class StreamingMeetingAudioPublisher {
  private readonly participants = new Map<string, ParticipantSession>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly startingTurns = new Map<string, { turnId: string; promise: Promise<StreamingMeetingAudioSession> }>();
  private disposed = false;

  public constructor(
    private readonly config: VoiceServiceConfig,
    private readonly tokenService: LivekitTokenService,
    private readonly adapter: ILivekitAdapter,
  ) {}

  public start(input: StreamingPublishInput): Promise<StreamingMeetingAudioSession> {
    const active = this.activeTurns.get(input.meetingSessionId);
    if (active) {
      if (active.input.turnId !== input.turnId) return Promise.reject(new StreamingPublishError('VOICE_LIVEKIT_PUBLISH_FAILED', 'Another streaming turn is active'));
      return Promise.resolve(this.toSession(active));
    }
    const starting = this.startingTurns.get(input.meetingSessionId);
    if (starting) {
      if (starting.turnId !== input.turnId) return Promise.reject(new StreamingPublishError('VOICE_LIVEKIT_PUBLISH_FAILED', 'Another streaming turn is starting'));
      return starting.promise;
    }
    const promise = this.open(input);
    this.startingTurns.set(input.meetingSessionId, { turnId: input.turnId, promise });
    void promise.then(
      () => { if (this.startingTurns.get(input.meetingSessionId)?.promise === promise) this.startingTurns.delete(input.meetingSessionId); },
      () => { if (this.startingTurns.get(input.meetingSessionId)?.promise === promise) this.startingTurns.delete(input.meetingSessionId); },
    );
    return promise;
  }

  private async open(input: StreamingPublishInput): Promise<StreamingMeetingAudioSession> {
    if (this.disposed || !this.config.livekitUrl || !this.config.livekitApiKey || !this.config.livekitApiSecret) {
      throw new StreamingPublishError('VOICE_LIVEKIT_PUBLISH_FAILED');
    }
    if (input.signal?.aborted) throw new StreamingPublishError('VOICE_CANCELLED');
    const participant = await this.ensureParticipant(input);
    const controller = new AbortController();
    const turn: ActiveTurn = {
      input,
      participant,
      controller,
      resampler: new Pcm48kResampler({
        maximumChunkBytes: this.config.googleStreamingTtsMaxQueuedBytes,
        maximumTotalInputBytes: this.config.voiceStreamingOutputMaxTotalPcmBytes,
      }),
      assembler: undefined as unknown as PcmFrameAssembler,
      terminal: false,
      finishPromise: null,
      firstFrameAtMs: null,
    };
    turn.assembler = new PcmFrameAssembler(async (frame) => {
      if (turn.terminal) throw new StreamingPublishError('VOICE_CANCELLED');
      await raceWithAbort(
        participant.source.captureFrame({
          data: frame.data,
          sampleRate: LIVEKIT_SAMPLE_RATE_HERTZ,
          numChannels: 1,
          samplesPerChannel: frame.samplesPerChannel,
        }),
        this.config.livekitConnectTimeoutMs,
        [input.signal, controller.signal],
      );
      if (turn.firstFrameAtMs === null) {
        turn.firstFrameAtMs = Date.now();
        input.onFirstFrame?.();
      }
    });
    this.activeTurns.set(input.meetingSessionId, turn);
    return this.toSession(turn);
  }

  public async closeMeeting(meetingSessionId: string): Promise<void> {
    const turn = this.activeTurns.get(meetingSessionId);
    if (turn) await this.cancelTurn(turn);
    const participant = this.participants.get(meetingSessionId);
    if (!participant) return;
    participant.closing = true;
    this.participants.delete(meetingSessionId);
    await Promise.allSettled([
      participant.source.close(),
      participant.track.close(false),
      participant.published ? participant.room.unpublishTrack(participant.track) : Promise.resolve(),
      participant.room.disconnect(),
    ]);
  }

  public async closeAll(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.participants.keys()].map((meetingSessionId) => this.closeMeeting(meetingSessionId)));
    await this.adapter.dispose();
  }

  private toSession(turn: ActiveTurn): StreamingMeetingAudioSession {
    return {
      write: async (chunk) => {
        this.assertCurrent(turn);
        try {
          await turn.assembler.write(turn.resampler.write(chunk));
        } catch (error) {
          await this.cancelTurn(turn);
          throw toPublishError(error);
        }
      },
      finish: () => {
        turn.finishPromise ??= this.finishTurn(turn);
        return turn.finishPromise;
      },
      cancel: () => this.cancelTurn(turn),
    };
  }

  private async finishTurn(turn: ActiveTurn): Promise<StreamingPublishSummary> {
    this.assertCurrent(turn);
    try {
      await turn.assembler.write(turn.resampler.finish());
      await turn.assembler.finish();
      await raceWithAbort(turn.participant.source.waitForPlayout(), this.config.livekitPlayoutTimeoutMs, [turn.input.signal, turn.controller.signal]);
      const summary: StreamingPublishSummary = {
        meetingSessionId: turn.input.meetingSessionId,
        roomName: turn.input.roomName,
        turnId: turn.input.turnId,
        identity: turn.participant.identity,
        firstFrameAtMs: turn.firstFrameAtMs,
        playoutCompletedAtMs: Date.now(),
        resampler: turn.resampler.summary(),
        frames: turn.assembler.summary(),
      };
      this.completeTurn(turn);
      return summary;
    } catch (error) {
      await this.cancelTurn(turn);
      throw toPublishError(error);
    }
  }

  private async ensureParticipant(input: StreamingPublishInput): Promise<ParticipantSession> {
    let participant = this.participants.get(input.meetingSessionId);
    if (participant) {
      if (participant.roomName !== input.roomName || participant.closing) throw new StreamingPublishError('VOICE_LIVEKIT_PUBLISH_FAILED');
      if (participant.connecting) await participant.connecting;
      return participant;
    }
    const source = this.adapter.createAudioSource(LIVEKIT_SAMPLE_RATE_HERTZ, 1);
    participant = {
      room: this.adapter.createRoom(),
      source,
      track: source.getTrack(),
      roomName: input.roomName,
      identity: `${input.meetingSessionId}-bot`,
      connecting: null,
      connected: false,
      published: false,
      closing: false,
    };
    this.participants.set(input.meetingSessionId, participant);
    participant.connecting = this.connectParticipant(input, participant);
    try {
      await participant.connecting;
      return participant;
    } catch (error) {
      this.participants.delete(input.meetingSessionId);
      await Promise.allSettled([source.close(), participant.room.disconnect()]);
      throw error;
    } finally {
      participant.connecting = null;
    }
  }

  private async connectParticipant(input: StreamingPublishInput, participant: ParticipantSession): Promise<void> {
    try {
      const token = await this.tokenService.generateToken({ roomName: input.roomName, meetingSessionId: input.meetingSessionId });
      await raceWithAbort(participant.room.connect(this.config.livekitUrl!, token), this.config.livekitConnectTimeoutMs, [input.signal]);
      await raceWithAbort(
        participant.room.publishTrack(participant.track, { source: TrackSource.SOURCE_MICROPHONE }),
        this.config.livekitConnectTimeoutMs,
        [input.signal],
      );
      participant.connected = true;
      participant.published = true;
    } catch (error) {
      if (error instanceof StreamingPublishError) throw error;
      throw new StreamingPublishError('VOICE_LIVEKIT_PUBLISH_FAILED', asError(error).message);
    }
  }

  private assertCurrent(turn: ActiveTurn): void {
    if (turn.terminal || this.activeTurns.get(turn.input.meetingSessionId) !== turn) {
      throw new StreamingPublishError('VOICE_CANCELLED');
    }
  }

  private completeTurn(turn: ActiveTurn): void {
    if (turn.terminal) return;
    turn.terminal = true;
    if (this.activeTurns.get(turn.input.meetingSessionId) === turn) this.activeTurns.delete(turn.input.meetingSessionId);
  }

  private async cancelTurn(turn: ActiveTurn): Promise<void> {
    if (turn.terminal) return;
    turn.terminal = true;
    turn.controller.abort('cancelled');
    turn.resampler.cancel();
    turn.assembler.cancel();
    try {
      turn.participant.source.clearQueue();
    } catch {
      // Native source may already be closed by meeting cleanup.
    }
    if (this.activeTurns.get(turn.input.meetingSessionId) === turn) this.activeTurns.delete(turn.input.meetingSessionId);
  }
}
