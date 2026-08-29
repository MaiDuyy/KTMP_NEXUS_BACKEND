import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { MeetingAudioPublisher, PublishMeetingAudioInput, VoiceError } from './MeetingAudioPublisher.js';
import { VoiceServiceConfig } from '../config.js';
import { LivekitTokenService } from './LivekitTokenService.js';
import { ILivekitAdapter, ILivekitAudioSource, ILivekitLocalAudioTrack, ILivekitRoom, ILivekitAudioFrame } from './LivekitAdapter.js';
import type { VoiceErrorCode } from '@ott/shared';
import type { BatchTtsResult } from '../batchTts.js';

function createMockWav(sampleRate: number, numSamples: number): Buffer {
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const fileSize = 36 + dataSize;
  const buffer = Buffer.alloc(fileSize + 8);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(fileSize, 4);
  buffer.write("WAVE", 8, "ascii");

  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34); // 16 bit

  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(i % 32767, 44 + i * 2);
  }

  return buffer;
}

class MockAudioSource implements ILivekitAudioSource {
  public frames: ILivekitAudioFrame[] = [];
  public playoutPromise: Promise<void> | null = null;
  public resolvePlayout: (() => void) | null = null;
  public clearQueueCalls = 0;
  public closeCalls = 0;
  public closeError: Error | null = null;
  public captureFrameImpl: ((frame: ILivekitAudioFrame, frameIndex: number) => Promise<void>) | null = null;
  public readonly track = new MockTrack();

  constructor(public sampleRate: number, public numChannels: number) {}

  async captureFrame(frame: ILivekitAudioFrame): Promise<void> {
    this.frames.push(frame);
    await this.captureFrameImpl?.(frame, this.frames.length - 1);
  }

  async waitForPlayout(): Promise<void> {
    if (!this.playoutPromise) {
      this.playoutPromise = new Promise(r => this.resolvePlayout = r);
    }
    await this.playoutPromise;
    this.playoutPromise = null;
    this.resolvePlayout = null;
  }

  clearQueue(): void {
    this.clearQueueCalls += 1;
    this.resolvePlayout?.();
  }

  getTrack(): ILivekitLocalAudioTrack {
    return this.track;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }
}

class MockTrack implements ILivekitLocalAudioTrack {
  public closeCalls = 0;
  public closeSourceArguments: Array<boolean | undefined> = [];
  public closeError: Error | null = null;

  async close(closeSource?: boolean): Promise<void> {
    this.closeCalls += 1;
    this.closeSourceArguments.push(closeSource);
    if (this.closeError) throw this.closeError;
  }
}

class MockRoom implements ILivekitRoom {
  public connectCalled = false;
  public disconnectCalled = false;
  public publishCalled = false;
  public unpublishCalled = false;
  public disconnectCalls = 0;
  public publishCalls = 0;
  public unpublishCalls = 0;
  public connectPromise: Promise<void> | null = null;
  public publishPromise: Promise<void> | null = null;
  public disconnectError: Error | null = null;
  public publishError: Error | null = null;
  public unpublishError: Error | null = null;
  public resolveConnect: (() => void) | null = null;
  public rejectConnect: ((e: Error) => void) | null = null;

  async connect(url: string, token: string): Promise<void> {
    this.connectCalled = true;
    if (this.connectPromise) {
      return this.connectPromise;
    }
  }

  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
    this.disconnectCalls += 1;
    if (this.disconnectError) throw this.disconnectError;
  }

  async publishTrack(track: ILivekitLocalAudioTrack): Promise<void> {
    this.publishCalled = true;
    this.publishCalls += 1;
    if (this.publishError) throw this.publishError;
    if (this.publishPromise) await this.publishPromise;
  }

  async unpublishTrack(track: ILivekitLocalAudioTrack): Promise<void> {
    this.unpublishCalled = true;
    this.unpublishCalls += 1;
    if (this.unpublishError) throw this.unpublishError;
  }
}

class MockLivekitAdapter implements ILivekitAdapter {
  public room: MockRoom | null = null;
  public audioSource: MockAudioSource | null = null;
  public readonly rooms: MockRoom[] = [];
  public readonly audioSources: MockAudioSource[] = [];
  public disposeCalls = 0;
  public disposeError: Error | null = null;

  createRoom(): MockRoom {
    this.room = new MockRoom();
    this.rooms.push(this.room);
    return this.room;
  }

  createAudioSource(sampleRate: number, numChannels: number): MockAudioSource {
    this.audioSource = new MockAudioSource(sampleRate, numChannels);
    this.audioSources.push(this.audioSource);
    return this.audioSource;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeError) throw this.disposeError;
  }
}

describe('MeetingAudioPublisher', () => {
  let config: VoiceServiceConfig;
  let tokenService: LivekitTokenService;
  let adapter: MockLivekitAdapter;
  let publisher: MeetingAudioPublisher;

  beforeEach(() => {
    config = {
      livekitUrl: 'wss://test',
      livekitApiKey: 'key',
      livekitApiSecret: 'secret',
      livekitConnectTimeoutMs: 1000,
      livekitPlayoutTimeoutMs: 1000,
      livekitAiParticipantName: 'AI'
    } as VoiceServiceConfig;
    tokenService = new LivekitTokenService(config);
    adapter = new MockLivekitAdapter();
    publisher = new MeetingAudioPublisher(config, tokenService, adapter);
  });

  const createInput = (turnId = 't1'): PublishMeetingAudioInput => ({
    meetingSessionId: 'm1',
    roomName: 'r1',
    turnId,
    audio: {
      audio: createMockWav(24000, 480 * 3 + 100), // 3 frames + 1 partial frame
      sampleRateHertz: 24000,
      contentType: 'audio/wav',
      encoding: 'LINEAR16',
      channelCount: 1
    }
  });

  test('credentials missing throws VOICE_LIVEKIT_PUBLISH_FAILED', async () => {
    config.livekitUrl = null;
    await assert.rejects(
      publisher.publish(createInput()),
      (err: VoiceError) => err.code === 'VOICE_LIVEKIT_PUBLISH_FAILED'
    );
  });

  test('first publish joins and creates track', async () => {
    const input = createInput();
    const pubPromise = publisher.publish(input);

    // Simulate connect
    await new Promise(r => setImmediate(r));
    assert.strictEqual(adapter.room?.connectCalled, true);
    assert.strictEqual(adapter.room?.publishCalled, true);

    // Simulate frames captured
    assert.strictEqual(adapter.audioSource?.frames.length, 4);
    assert.strictEqual(adapter.audioSource?.frames[0].samplesPerChannel, 480);
    assert.strictEqual(adapter.audioSource?.frames[3].samplesPerChannel, 100);

    // Simulate playout
    adapter.audioSource?.resolvePlayout?.();
    const result = await pubPromise;

    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.identity, 'm1-bot');
  });

  test('subsequent publish reuses room and track', async () => {
    const input1 = createInput('t1');
    const pubPromise1 = publisher.publish(input1);
    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await pubPromise1;

    // Reset spies
    if (adapter.room) {
      adapter.room.connectCalled = false;
      adapter.room.publishCalled = false;
    }
    const prevSource = adapter.audioSource;

    const input2 = createInput('t2');
    const pubPromise2 = publisher.publish(input2);
    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await pubPromise2;

    assert.strictEqual(adapter.room?.connectCalled, false);
    assert.strictEqual(adapter.room?.publishCalled, false);
    assert.strictEqual(adapter.audioSource, prevSource); // Same source
  });

  test('retry same turn pending/completed returns idempotent', async () => {
    const input1 = createInput('t1');
    const pubPromise1 = publisher.publish(input1);

    // Retry pending
    const pubPromise2 = publisher.publish(input1);

    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    const res1 = await pubPromise1;
    const res2 = await pubPromise2;
    assert.deepStrictEqual(res1, res2);

    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await pubPromise1;

    // Retry completed
    const result3 = await publisher.publish(input1);
    assert.strictEqual(result3.completed, true);
  });

  test('concurrent different turn throws VOICE_LIVEKIT_PUBLISH_FAILED', async () => {
    const input1 = createInput('t1');
    const pubPromise1 = publisher.publish(input1);

    const input2 = createInput('t2');

    // We don't await immediately, but we can't let it hang.
    // wait for it to process
    await new Promise(r => setImmediate(r));

    await assert.rejects(
      publisher.publish(input2),
      (err: VoiceError) => err.code === 'VOICE_LIVEKIT_PUBLISH_FAILED' && err.message.includes('Another turn')
    );

    adapter.audioSource?.resolvePlayout?.();
    await pubPromise1;
  });

  test('cancel during playout clears queue and throws VOICE_CANCELLED', async () => {
    const ac = new AbortController();
    const input = createInput('t1');
    input.signal = ac.signal;

    const pubPromise = publisher.publish(input);
    await new Promise(r => setImmediate(r)); // Wait until playout

    ac.abort(); // Abort during playout

    await assert.rejects(
      pubPromise,
      (err: VoiceError) => err.code === 'VOICE_CANCELLED'
    );
    assert.ok((adapter.audioSource?.clearQueueCalls ?? 0) > 0);
  });

  test('closeMeeting is idempotent and cleans up', async () => {
    const input = createInput('t1');
    const pubPromise = publisher.publish(input);
    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await pubPromise;

    await publisher.closeMeeting('m1');
    assert.strictEqual(adapter.room?.disconnectCalled, true);
    assert.strictEqual(adapter.room?.unpublishCalled, true);
    assert.ok((adapter.audioSource?.clearQueueCalls ?? 0) > 0);

    // Call again, should not crash
    await publisher.closeMeeting('m1');
  });

  test('metadata mismatch throws VOICE_LIVEKIT_PUBLISH_FAILED', async () => {
    const input = createInput('t1');
    input.audio.sampleRateHertz = 48000;

    await assert.rejects(
      publisher.publish(input),
      (err: VoiceError) => err.code === 'VOICE_LIVEKIT_PUBLISH_FAILED'
    );
  });

  test('cancel before connect deletes session and throws VOICE_CANCELLED', async () => {
    const ac = new AbortController();
    ac.abort();
    const input = createInput('t1');
    input.signal = ac.signal;

    await assert.rejects(
      publisher.publish(input),
      (err: VoiceError) => err.code === 'VOICE_CANCELLED'
    );
  });

  test('connect timeout throws VOICE_LIVEKIT_PUBLISH_FAILED', async () => {
    config.livekitConnectTimeoutMs = 10;
    const input = createInput('t1');

    // Room connect mock that hangs
    const oldCreateRoom = adapter.createRoom.bind(adapter);
    adapter.createRoom = () => {
      const room = oldCreateRoom();
      (room as MockRoom).connectPromise = new Promise(() => {}); // never resolves
      return room;
    };

    await assert.rejects(
      publisher.publish(input),
      (err: VoiceError) => err.code === 'VOICE_LIVEKIT_PUBLISH_FAILED' && err.message.includes('Connect timeout')
    );
  });

  test('playout timeout throws VOICE_LIVEKIT_PUBLISH_FAILED', async () => {
    config.livekitPlayoutTimeoutMs = 10;
    const input = createInput('t1');

    // Do not resolve playout
    await assert.rejects(
      publisher.publish(input),
      (err: VoiceError) => err.code === 'VOICE_LIVEKIT_PUBLISH_FAILED' && err.message.includes('Playout timeout')
    );
  });

  test('closeAll closes all active meetings safely', async () => {
    const input1 = createInput('t1');
    const input2 = createInput('t2');
    input2.meetingSessionId = 'm2';
    input2.roomName = 'r2';

    const pub1 = publisher.publish(input1);
    const pub2 = publisher.publish(input2);

    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();

    await publisher.closeAll();

    assert.strictEqual(adapter.room?.disconnectCalled, true);
    assert.strictEqual(adapter.room?.unpublishCalled, true);
    assert.ok((adapter.audioSource?.clearQueueCalls ?? 0) > 0);

    // Also resolve playout for second room if needed to let them close cleanly
    await Promise.allSettled([pub1, pub2]);
  });

  test('retrying an older completed turn does not replay audio', async () => {
    const first = publisher.publish(createInput('t1'));
    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await first;

    const second = publisher.publish(createInput('t2'));
    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await second;

    const frameCount = adapter.audioSource?.frames.length;
    const retried = await publisher.publish(createInput('t1'));
    assert.strictEqual(retried.turnId, 't1');
    assert.strictEqual(adapter.audioSource?.frames.length, frameCount);
  });

  test('cancelled turn keeps the participant reusable', async () => {
    const controller = new AbortController();
    const cancelledInput = createInput('t1');
    cancelledInput.signal = controller.signal;
    const cancelled = publisher.publish(cancelledInput);
    await new Promise(r => setImmediate(r));
    controller.abort();
    await assert.rejects(cancelled, (error: VoiceError) => error.code === 'VOICE_CANCELLED');

    const next = publisher.publish(createInput('t2'));
    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await next;

    assert.strictEqual(adapter.rooms.length, 1);
    assert.strictEqual(adapter.audioSources.length, 1);
  });

  test('abort while a frame is pending stops the turn and clears the queue', async () => {
    let releaseFrame: (() => void) | undefined;
    const framePending = new Promise<void>(resolve => { releaseFrame = resolve; });
    const source = adapter.createAudioSource(24000, 1);
    source.captureFrameImpl = async (_frame, index) => {
      if (index === 0) await framePending;
    };
    const originalCreateSource = adapter.createAudioSource.bind(adapter);
    adapter.createAudioSource = () => source;

    const controller = new AbortController();
    const input = createInput('t1');
    input.signal = controller.signal;
    const publishing = publisher.publish(input);
    await new Promise(r => setImmediate(r));
    controller.abort();

    await assert.rejects(publishing, (error: VoiceError) => error.code === 'VOICE_CANCELLED');
    assert.ok(source.clearQueueCalls > 0);
    releaseFrame?.();
    adapter.createAudioSource = originalCreateSource;
  });

  test('connect abort cleans resources and a late connect is disconnected', async () => {
    let resolveConnect: (() => void) | undefined;
    const pendingConnect = new Promise<void>(resolve => { resolveConnect = resolve; });
    const room = adapter.createRoom();
    room.connectPromise = pendingConnect;
    adapter.createRoom = () => room;

    const controller = new AbortController();
    const input = createInput('t1');
    input.signal = controller.signal;
    const publishing = publisher.publish(input);
    await new Promise(r => setImmediate(r));
    controller.abort();

    await assert.rejects(publishing, (error: VoiceError) => error.code === 'VOICE_CANCELLED');
    const disconnectsAfterCleanup = room.disconnectCalls;
    resolveConnect?.();
    await new Promise(r => setImmediate(r));
    assert.ok(room.disconnectCalls > disconnectsAfterCleanup);
    assert.strictEqual(adapter.audioSource?.closeCalls, 1);
  });

  test('publish track timeout maps the error and cleans initialization resources', async () => {
    config.livekitConnectTimeoutMs = 10;
    const room = adapter.createRoom();
    room.publishPromise = new Promise(() => {});
    adapter.createRoom = () => room;

    await assert.rejects(
      publisher.publish(createInput('t1')),
      (error: VoiceError) => error.code === 'VOICE_LIVEKIT_PUBLISH_FAILED' && error.message.includes('Publish track timeout'),
    );
    assert.strictEqual(adapter.audioSource?.track.closeCalls, 1);
    assert.strictEqual(adapter.audioSource?.closeCalls, 1);
    assert.ok(room.disconnectCalls > 0);
  });

  test('concurrent closeMeeting calls close each native resource once', async () => {
    const publishing = publisher.publish(createInput('t1'));
    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await publishing;

    await Promise.all([publisher.closeMeeting('m1'), publisher.closeMeeting('m1')]);

    assert.strictEqual(adapter.room?.unpublishCalls, 1);
    assert.strictEqual(adapter.room?.disconnectCalls, 1);
    assert.strictEqual(adapter.audioSource?.track.closeCalls, 1);
    assert.deepStrictEqual(adapter.audioSource?.track.closeSourceArguments, [false]);
    assert.strictEqual(adapter.audioSource?.closeCalls, 1);
  });

  test('cleanup attempts disconnect and source close after partial failure', async () => {
    const publishing = publisher.publish(createInput('t1'));
    await new Promise(r => setImmediate(r));
    adapter.audioSource?.resolvePlayout?.();
    await publishing;

    adapter.room!.unpublishError = new Error('unpublish failed');
    adapter.audioSource!.track.closeError = new Error('track close failed');
    await assert.rejects(publisher.closeMeeting('m1'), AggregateError);

    assert.strictEqual(adapter.audioSource?.closeCalls, 1);
    assert.strictEqual(adapter.room?.disconnectCalls, 1);
  });

  test('closeAll and adapter disposal are idempotent', async () => {
    await Promise.all([publisher.closeAll(), publisher.closeAll()]);
    assert.strictEqual(adapter.disposeCalls, 1);
    await assert.rejects(
      publisher.publish(createInput('t1')),
      (error: VoiceError) => error.message.includes('disposed'),
    );
  });
});
