import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { MeetingAudioPublisher, PublishMeetingAudioInput } from './MeetingAudioPublisher.js';
import { loadVoiceServiceConfig } from '../config.js';
import { LivekitTokenService } from './LivekitTokenService.js';
import { DefaultLivekitAdapter } from './LivekitAdapter.js';
import { Room, RoomEvent, AudioStream, RemoteAudioTrack, TrackKind } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
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

  // Create a 1kHz sine wave for test audio
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const value = Math.sin(2 * Math.PI * 1000 * t) * 10000;
    buffer.writeInt16LE(Math.floor(value), 44 + i * 2);
  }

  return buffer;
}

describe('MeetingAudioPublisher Integration', () => {
  const config = loadVoiceServiceConfig();
  const hasLivekitEnv = !!(config.livekitUrl && config.livekitApiKey && config.livekitApiSecret);

  if (!hasLivekitEnv) {
    test.skip('Skipping integration test due to missing LIVEKIT_URL, LIVEKIT_API_KEY, or LIVEKIT_API_SECRET', () => {});
    return;
  }

  const tokenService = new LivekitTokenService(config);
  const adapter = new DefaultLivekitAdapter();
  const publisher = new MeetingAudioPublisher(config, tokenService, adapter);

  after(async () => {
    await publisher.closeAll();
  });

  test('Publishes audio and multiple subscribers receive it', async () => {
    const meetingSessionId = `test-meet-${Date.now()}`;
    const roomName = `test-room-${Date.now()}`;
    const otherRoomName = `test-other-${Date.now()}`;

    // Token for subscribers with canSubscribe: true
    const createSubToken = async (identity: string, targetRoom: string) => {
      const at = new AccessToken(config.livekitApiKey!, config.livekitApiSecret!, { identity });
      at.addGrant({ roomJoin: true, room: targetRoom, canSubscribe: true, canPublish: false });
      return await at.toJwt();
    };

    const subToken1 = await createSubToken('sub1', roomName);
    const subToken2 = await createSubToken('sub2', roomName);
    const otherRoomToken = await createSubToken('sub3', otherRoomName);

    const roomSub1 = new Room();
    const roomSub2 = new Room();
    const roomOther = new Room();

      const streams: AudioStream[] = [];
      const readerTasks: Promise<void>[] = [];
      let resolveSub1Frame: (() => void) | undefined;
      let resolveSub2Frame: (() => void) | undefined;
      const sub1FirstFrame = new Promise<void>(resolve => { resolveSub1Frame = resolve; });
      const sub2FirstFrame = new Promise<void>(resolve => { resolveSub2Frame = resolve; });
      const createReader = (stream: AudioStream, counter: { count: number }, onFirstFrame: () => void) => {
        streams.push(stream);
        const task = (async () => {
          try {
            for await (const _frame of stream) {
              counter.count++;
              if (counter.count === 1) onFirstFrame();
            }
          } catch {
            // Cancellation is expected during test cleanup.
          }
        })();
        readerTasks.push(task);
      };

      const sub1Counter = { count: 0 };
      const sub2Counter = { count: 0 };

      roomSub1.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === TrackKind.KIND_AUDIO) {
           const stream = new AudioStream(track as RemoteAudioTrack);
          createReader(stream, sub1Counter, () => resolveSub1Frame?.());
        }
      });

      roomSub2.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === TrackKind.KIND_AUDIO) {
           const stream = new AudioStream(track as RemoteAudioTrack);
          createReader(stream, sub2Counter, () => resolveSub2Frame?.());
        }
      });

      try {
        await Promise.all([
          roomSub1.connect(config.livekitUrl!, subToken1),
          roomSub2.connect(config.livekitUrl!, subToken2),
          roomOther.connect(config.livekitUrl!, otherRoomToken)
        ]);

        const withTimeout = <T>(promise: Promise<T>, ms: number, msg: string) => {
          let timer: NodeJS.Timeout;
          const timeoutPromise = new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(msg)), ms);
          });
          return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
        };

        const sub1TrackSubscribed = new Promise<void>(resolve => roomSub1.once(RoomEvent.TrackSubscribed, () => resolve()));
        const sub2TrackSubscribed = new Promise<void>(resolve => roomSub2.once(RoomEvent.TrackSubscribed, () => resolve()));

        // Bot publish
        const wav = createMockWav(24000, 24000 * 2); // 2 seconds of audio
        const audio: BatchTtsResult = {
          audio: wav,
          sampleRateHertz: 24000,
          contentType: 'audio/wav',
          encoding: 'LINEAR16',
          channelCount: 1
        };

        const result = await publisher.publish({
          meetingSessionId,
          roomName,
          turnId: 't1',
          audio
        });

        assert.strictEqual(result.completed, true);
        assert.strictEqual(result.identity, `${meetingSessionId}-bot`);

        // Wait for subscribers to see the track with timeout
        await withTimeout(Promise.all([sub1TrackSubscribed, sub2TrackSubscribed]), 10000, 'Waiting for TrackSubscribed timeout');

        await withTimeout(Promise.all([sub1FirstFrame, sub2FirstFrame]), 10000, 'Waiting for audio frames timeout');

        assert.ok(sub1Counter.count > 0, 'Sub1 should have received audio frames');
        assert.ok(sub2Counter.count > 0, 'Sub2 should have received audio frames');

        // Verify the other room did NOT see the track
        const otherParticipants = Array.from(roomOther.remoteParticipants.values());
        assert.strictEqual(otherParticipants.length, 0, 'Other room should not see the bot participant');

        const botLeft = new Promise<void>(resolve => {
          roomSub1.on(RoomEvent.ParticipantDisconnected, participant => {
            if (participant.identity === result.identity) resolve();
          });
        });
        await publisher.closeMeeting(meetingSessionId);
        await withTimeout(botLeft, 10000, 'Waiting for bot disconnect timeout');

        const sub1Participants = Array.from(roomSub1.remoteParticipants.values());
        const botStillThere = sub1Participants.find(p => p.identity === result.identity);
        assert.ok(!botStillThere, 'Bot should have left the room');

      } finally {
        // Cleanup streams
        for (const s of streams) {
          await s.cancel().catch(() => {});
        }
        await Promise.allSettled(readerTasks);
        await Promise.allSettled([
          publisher.closeMeeting(meetingSessionId),
          roomSub1.disconnect(),
          roomSub2.disconnect(),
          roomOther.disconnect()
        ]);
      }
    });
  });
