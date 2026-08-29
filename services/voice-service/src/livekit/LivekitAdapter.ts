import { Room, AudioSource, LocalAudioTrack, AudioFrame, TrackSource, RoomOptions, TrackPublishOptions, dispose as livekitDispose } from '@livekit/rtc-node';

export interface ILivekitAudioFrame {
  data: Int16Array;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number;
}

export { TrackSource };

export interface ILivekitAudioSource {
  captureFrame(frame: ILivekitAudioFrame): Promise<void>;
  waitForPlayout(): Promise<void>;
  clearQueue(): void;
  getTrack(): ILivekitLocalAudioTrack;
  close(): Promise<void>;
}

export interface ILivekitLocalAudioTrack {
  close(closeSource?: boolean): Promise<void>;
}

export interface ILivekitRoom {
  connect(url: string, token: string, options?: RoomOptions): Promise<void>;
  disconnect(): Promise<void>;
  publishTrack(track: ILivekitLocalAudioTrack, options?: { source?: TrackSource }): Promise<void>;
  unpublishTrack(track: ILivekitLocalAudioTrack): Promise<void>;
}

export interface ILivekitAdapter {
  createRoom(): ILivekitRoom;
  createAudioSource(sampleRate: number, numChannels: number): ILivekitAudioSource;
  dispose(): Promise<void>;
}

class DefaultLivekitRoom implements ILivekitRoom {
  private room: Room;

  constructor() {
    this.room = new Room();
  }

  async connect(url: string, token: string, options?: RoomOptions): Promise<void> {
    await this.room.connect(url, token, options);
  }

  async disconnect(): Promise<void> {
    await this.room.disconnect();
  }

  async publishTrack(track: ILivekitLocalAudioTrack, options?: { source?: TrackSource }): Promise<void> {
    const realTrack = track as unknown as LocalAudioTrack;
    const localParticipant = this.room.localParticipant;
    if (!localParticipant) throw new Error('LiveKit local participant is unavailable');
    await localParticipant.publishTrack(realTrack, options as TrackPublishOptions);
  }

  async unpublishTrack(track: ILivekitLocalAudioTrack): Promise<void> {
    const realTrack = track as unknown as LocalAudioTrack;
    if (realTrack.sid) {
      await this.room.localParticipant?.unpublishTrack(realTrack.sid);
    }
  }
}

class DefaultLivekitAudioSource implements ILivekitAudioSource {
  private source: AudioSource;
  private closed = false;

  constructor(sampleRate: number, numChannels: number) {
    this.source = new AudioSource(sampleRate, numChannels);
  }

  async captureFrame(frame: ILivekitAudioFrame): Promise<void> {
    const rtcFrame = new AudioFrame(
      frame.data,
      frame.sampleRate,
      frame.numChannels,
      frame.samplesPerChannel
    );
    await this.source.captureFrame(rtcFrame);
  }

  async waitForPlayout(): Promise<void> {
    await this.source.waitForPlayout();
  }

  clearQueue(): void {
    this.source.clearQueue();
  }

  getTrack(): ILivekitLocalAudioTrack {
    return LocalAudioTrack.createAudioTrack('audio', this.source) as unknown as ILivekitLocalAudioTrack;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.source.close();
  }
}

export class DefaultLivekitAdapter implements ILivekitAdapter {
  private disposePromise: Promise<void> | null = null;

  createRoom(): ILivekitRoom {
    return new DefaultLivekitRoom();
  }

  createAudioSource(sampleRate: number, numChannels: number): ILivekitAudioSource {
    return new DefaultLivekitAudioSource(sampleRate, numChannels);
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = Promise.resolve().then(() => livekitDispose());
    }
    return this.disposePromise;
  }
}
