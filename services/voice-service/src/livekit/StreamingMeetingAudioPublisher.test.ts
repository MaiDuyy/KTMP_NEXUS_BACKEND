import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { VoiceServiceConfig } from '../config.js';
import type { StreamingPcmChunk } from '../streaming/googleStreamingTts.js';
import type { ILivekitAdapter, ILivekitAudioFrame, ILivekitAudioSource, ILivekitLocalAudioTrack, ILivekitRoom } from './LivekitAdapter.js';
import { LivekitTokenService } from './LivekitTokenService.js';
import { StreamingMeetingAudioPublisher, StreamingPublishError } from './StreamingMeetingAudioPublisher.js';

class FakeTrack implements ILivekitLocalAudioTrack { async close(): Promise<void> {} }
class FakeSource extends EventEmitter implements ILivekitAudioSource {
  public readonly frames: ILivekitAudioFrame[] = [];
  public clearQueueCalls = 0;
  public holdPlayout = false;
  public captureError: Error | null = null;
  private resolvePlayout: (() => void) | null = null;
  public async captureFrame(frame: ILivekitAudioFrame): Promise<void> {
    if (this.captureError) throw this.captureError;
    this.frames.push(frame);
  }
  public async waitForPlayout(): Promise<void> {
    if (!this.holdPlayout) return;
    await new Promise<void>((resolve) => { this.resolvePlayout = resolve; });
  }
  public clearQueue(): void { this.clearQueueCalls += 1; this.resolvePlayout?.(); }
  public getTrack(): ILivekitLocalAudioTrack { return new FakeTrack(); }
  public async close(): Promise<void> {}
}
class FakeRoom implements ILivekitRoom {
  public connectCalls = 0;
  public publishCalls = 0;
  public connectError: Error | null = null;
  public publishError: Error | null = null;
  public async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
  }
  public async disconnect(): Promise<void> {}
  public async publishTrack(): Promise<void> {
    this.publishCalls += 1;
    if (this.publishError) throw this.publishError;
  }
  public async unpublishTrack(): Promise<void> {}
}
class FakeAdapter implements ILivekitAdapter {
  public readonly source = new FakeSource();
  public readonly room = new FakeRoom();
  public createRoom(): ILivekitRoom { return this.room; }
  public createAudioSource(): ILivekitAudioSource { return this.source; }
  public async dispose(): Promise<void> {}
}

function config(): VoiceServiceConfig {
  return {
    livekitUrl: 'wss://livekit.test', livekitApiKey: 'key', livekitApiSecret: 'secret',
    livekitConnectTimeoutMs: 500, livekitPlayoutTimeoutMs: 500,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerOpenDurationMs: 1_000,
    circuitBreakerHalfOpenProbeLimit: 1,
    circuitBreakerFailureWindowMs: 60_000,
    googleStreamingTtsMaxQueuedBytes: 512 * 1024,
    voiceStreamingOutputMaxTotalPcmBytes: 8 * 1024 * 1024,
  } as unknown as VoiceServiceConfig;
}
function pcm(sequence: number, samples: number[]): StreamingPcmChunk {
  const audio = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => audio.writeInt16LE(sample, index * 2));
  return { segmentSequence: sequence, audio, encoding: 'PCM16LE', sampleRateHertz: 24_000, channelCount: 1, receivedAtMs: 1 };
}

test('publishes a 48 kHz 20 ms frame, waits for playout, and reuses the participant', async () => {
  const adapter = new FakeAdapter();
  const publisher = new StreamingMeetingAudioPublisher(config(), new LivekitTokenService(config()), adapter);
  let firstFrameEvents = 0;
  const session = await publisher.start({ meetingSessionId: 'meeting-1', roomName: 'room-1', turnId: 'turn-1', onFirstFrame: () => { firstFrameEvents += 1; } });
  await session.write(pcm(0, Array.from({ length: 480 }, (_, index) => index)));
  await session.write(pcm(1, Array.from({ length: 480 }, (_, index) => index)));
  const summary = await session.finish();
  assert.deepEqual(await session.finish(), summary);
  assert.equal(adapter.source.frames.length, 2);
  assert.ok(adapter.source.frames.every((frame) => frame.sampleRate === 48_000 && frame.samplesPerChannel === 960));
  assert.equal(firstFrameEvents, 1);
  assert.equal(summary.frames.frameCount, 2);
  assert.equal(summary.frames.paddedSamples, 0);

  const next = await publisher.start({ meetingSessionId: 'meeting-1', roomName: 'room-1', turnId: 'turn-2' });
  await next.cancel();
  assert.equal(adapter.room.connectCalls, 1);
  assert.equal(adapter.room.publishCalls, 1);
});

test('does not complete a turn until playout resolves and cancel clears the native queue', async () => {
  const adapter = new FakeAdapter();
  adapter.source.holdPlayout = true;
  const publisher = new StreamingMeetingAudioPublisher(config(), new LivekitTokenService(config()), adapter);
  const session = await publisher.start({ meetingSessionId: 'meeting-1', roomName: 'room-1', turnId: 'turn-1' });
  await session.write(pcm(0, Array.from({ length: 480 }, () => 10)));
  const finishing = session.finish();
  await new Promise((resolve) => setImmediate(resolve));
  await session.cancel();
  await assert.rejects(finishing, (error: unknown) => error instanceof StreamingPublishError && error.code === 'VOICE_CANCELLED');
  assert.ok(adapter.source.clearQueueCalls > 0);
});

test('rejects a second active turn in the same meeting without publishing another track', async () => {
  const adapter = new FakeAdapter();
  const publisher = new StreamingMeetingAudioPublisher(config(), new LivekitTokenService(config()), adapter);
  const first = await publisher.start({ meetingSessionId: 'meeting-1', roomName: 'room-1', turnId: 'turn-1' });
  await assert.rejects(
    publisher.start({ meetingSessionId: 'meeting-1', roomName: 'room-1', turnId: 'turn-2' }),
    (error: unknown) => error instanceof StreamingPublishError && error.code === 'VOICE_LIVEKIT_PUBLISH_FAILED',
  );
  await first.cancel();
  assert.equal(adapter.room.publishCalls, 1);
});

test('records connection and streaming publish failures against separate LiveKit circuits', async () => {
  const connectAdapter = new FakeAdapter();
  connectAdapter.room.connectError = new Error('connect unavailable');
  const connectPublisher = new StreamingMeetingAudioPublisher(config(), new LivekitTokenService(config()), connectAdapter);
  await assert.rejects(connectPublisher.start({ meetingSessionId: 'meeting-connect', roomName: 'room-1', turnId: 'turn-1' }));
  assert.equal((connectPublisher as any).connectCircuitBreaker.getState(), 'OPEN');
  assert.equal((connectPublisher as any).publishCircuitBreaker.getState(), 'CLOSED');

  const publishAdapter = new FakeAdapter();
  publishAdapter.room.publishError = new Error('publish unavailable');
  const publishPublisher = new StreamingMeetingAudioPublisher(config(), new LivekitTokenService(config()), publishAdapter);
  await assert.rejects(publishPublisher.start({ meetingSessionId: 'meeting-publish', roomName: 'room-1', turnId: 'turn-1' }));
  assert.equal((publishPublisher as any).connectCircuitBreaker.getState(), 'CLOSED');
  assert.equal((publishPublisher as any).publishCircuitBreaker.getState(), 'OPEN');
});

test('records native frame failures against the publish circuit', async () => {
  const adapter = new FakeAdapter();
  adapter.source.captureError = new Error('native capture unavailable');
  const publisher = new StreamingMeetingAudioPublisher(config(), new LivekitTokenService(config()), adapter);
  const session = await publisher.start({ meetingSessionId: 'meeting-frame', roomName: 'room-1', turnId: 'turn-1' });
  await session.write(pcm(0, Array.from({ length: 480 }, () => 1)));
  await assert.rejects(session.write(pcm(1, Array.from({ length: 480 }, () => 1))));
  assert.equal((publisher as any).publishCircuitBreaker.getState(), 'OPEN');
});
