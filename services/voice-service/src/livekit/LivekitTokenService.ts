import { AccessToken } from "livekit-server-sdk";
import { VoiceServiceConfig } from "../config.js";

export class LivekitTokenService {
  constructor(private readonly config: VoiceServiceConfig) {}

  async generateToken(input: { meetingSessionId: string; roomName: string }): Promise<string> {
    const at = new AccessToken(this.config.livekitApiKey!, this.config.livekitApiSecret!, {
      identity: `${input.meetingSessionId}-bot`,
      name: this.config.livekitAiParticipantName,
      ttl: 15 * 60,
    });

    at.addGrant({
      roomJoin: true,
      room: input.roomName,
      canPublish: true,
      canPublishData: false,
      canSubscribe: false,
    });

    return await at.toJwt();
  }
}
