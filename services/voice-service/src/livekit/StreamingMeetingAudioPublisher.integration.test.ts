import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessToken } from 'livekit-server-sdk';
import { AudioStream, RemoteAudioTrack, Room, RoomEvent, TrackKind } from '@livekit/rtc-node';
import { loadVoiceServiceConfig } from '../config.js';
import { DefaultLivekitAdapter } from './LivekitAdapter.js';
import { LivekitTokenService } from './LivekitTokenService.js';
import { StreamingMeetingAudioPublisher } from './StreamingMeetingAudioPublisher.js';

const runLivekitIntegration = ['true', '1'].includes(process.env.VOICE_LIVEKIT_INTEGRATION ?? '');

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function pcm(sequence: number, sampleCount: number) {
  const audio = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    audio.writeInt16LE(Math.round(Math.sin(index / 8) * 5_000), index * 2);
  }
  return { segmentSequence: sequence, audio, encoding: 'PCM16LE' as const, sampleRateHertz: 24_000, channelCount: 1 as const, receivedAtMs: Date.now() };
}

test('streams one LiveKit AI track to two subscribers before playout completes', { skip: runLivekitIntegration ? undefined : 'VOICE_LIVEKIT_INTEGRATION is not enabled' }, async () => {
  const config = loadVoiceServiceConfig();
  assert.ok(config.livekitUrl && config.livekitApiKey && config.livekitApiSecret, 'LiveKit credentials are required');
  const meetingSessionId = `streaming-test-${Date.now()}`;
  const roomName = `streaming-room-${Date.now()}`;
  const publisher = new StreamingMeetingAudioPublisher(config, new LivekitTokenService(config), new DefaultLivekitAdapter());
  const subscribers = [new Room(), new Room()];
  const streams: AudioStream[] = [];
  const readerTasks: Promise<void>[] = [];
  const received = [0, 0];
  const trackSubscribed = [0, 1].map((index) => new Promise<void>((resolve) => {
    subscribers[index].once(RoomEvent.TrackSubscribed, () => resolve());
  }));
  const firstFrames = [0, 1].map((index) => new Promise<void>((resolve) => {
    subscribers[index].on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      const stream = new AudioStream(track as RemoteAudioTrack);
      streams.push(stream);
      const task = (async () => {
        try {
          for await (const _frame of stream) {
            received[index] += 1;
            resolve();
          }
        } catch {
          // Cancellation is expected during test cleanup
        }
      })();
      readerTasks.push(task);
    });
  }));
  try {
    const tokens = await Promise.all(['subscriber-1', 'subscriber-2'].map(async (identity) => {
      const token = new AccessToken(config.livekitApiKey!, config.livekitApiSecret!, { identity });
      token.addGrant({ roomJoin: true, room: roomName, canSubscribe: true, canPublish: false });
      return token.toJwt();
    }));
    await withTimeout(
      Promise.all(subscribers.map((room, index) => room.connect(config.livekitUrl!, tokens[index]))),
      15_000,
      'Subscribers could not connect to LiveKit',
    );
    const session = await publisher.start({ meetingSessionId, roomName, turnId: 'turn-1' });
    await withTimeout(Promise.all(trackSubscribed), 15_000, 'Subscribers did not subscribe to the AI track');
    await session.write(pcm(0, 12_000));
    const finishing = session.finish();
    await withTimeout(Promise.all(firstFrames), 15_000, 'Subscribers did not receive the streaming audio track');
    const summary = await withTimeout(finishing, 15_000, 'Streaming playout did not complete');
    assert.ok(summary.firstFrameAtMs !== null);
    assert.ok(received.every((count) => count > 0));
  } finally {
    // Close the publisher and rooms first: rtc-node then ends AudioStream readers.
    await Promise.allSettled([publisher.closeAll(), ...subscribers.map((room) => room.disconnect())]);
    for (const stream of streams) {
      try {
        if (typeof (stream as any).cancel === 'function') {
          await Promise.resolve((stream as any).cancel());
        } else if (typeof (stream as any).close === 'function') {
          (stream as any).close();
        }
      } catch {}
    }
    // A native reader must never leave the integration suite waiting indefinitely.
    await withTimeout(Promise.allSettled(readerTasks), 5_000, 'Subscriber reader cleanup timed out').catch(() => undefined);
  }
});
