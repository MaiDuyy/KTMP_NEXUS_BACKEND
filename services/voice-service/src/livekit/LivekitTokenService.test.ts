import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LivekitTokenService } from './LivekitTokenService.js';
import { VoiceServiceConfig } from '../config.js';
import { TokenVerifier } from 'livekit-server-sdk';

describe('LivekitTokenService', () => {
  const config = {
    livekitApiKey: 'test-key',
    livekitApiSecret: 'test-secret',
    livekitAiParticipantName: 'Nexus AI'
  } as VoiceServiceConfig;

  const service = new LivekitTokenService(config);

  test('generateToken encodes correct identity, room, and grants', async () => {
    const token = await service.generateToken({
      meetingSessionId: 'meet-123',
      roomName: 'room-abc'
    });

    const claims = await new TokenVerifier(config.livekitApiKey!, config.livekitApiSecret!).verify(token);

    // Check JWT standard claims
    assert.strictEqual(claims.sub, 'meet-123-bot');
    assert.strictEqual(claims.name, 'Nexus AI');

    // Check VideoGrant claims
    assert.ok(claims.video);
    assert.strictEqual(claims.video.roomJoin, true);
    assert.strictEqual(claims.video.room, 'room-abc');
    assert.strictEqual(claims.video.canPublish, true);
    assert.strictEqual(claims.video.canSubscribe, false);
    assert.strictEqual(claims.video.canPublishData, false);

    // TTL check
    assert.ok(claims.exp);
    assert.ok(claims.nbf);
    assert.strictEqual(claims.exp - claims.nbf, 15 * 60);
  });
});
