import { fileURLToPath } from "node:url";
import { loadVoiceServiceConfig, type VoiceServiceConfig } from "./config.js";
import { createVoiceHttpServer } from "./httpServer.js";
import { createVoiceServiceLogger, type VoiceServiceLogger } from "./logger.js";
import { createGracefulShutdown } from "./shutdown.js";
import { Redis } from "ioredis";
import { RedisTurnTokenReplayGuard } from "./turnTokenReplayGuard.js";
import { VoiceTurnTokenVerifier } from "./turnTokenVerifier.js";
import { MeetingAudioPublisher } from "./livekit/MeetingAudioPublisher.js";
import { LivekitTokenService } from "./livekit/LivekitTokenService.js";
import { DefaultLivekitAdapter } from "./livekit/LivekitAdapter.js";
import { closeVoiceServiceResources } from "./resourceCleanup.js";
import { GoogleBatchSttAdapter } from './batchStt.js';
import { GoogleBatchTtsAdapter } from './batchTts.js';
import { MeetingAiClient, VoiceControlClient } from './internalClients.js';
import { BatchVoiceOrchestrator } from './batchVoiceOrchestrator.js';

export interface VoiceServiceInstance {
  config: VoiceServiceConfig;
  logger: VoiceServiceLogger;
  start: () => Promise<void>;
}

export function createVoiceService(
  config: VoiceServiceConfig = loadVoiceServiceConfig(),
  logger: VoiceServiceLogger = createVoiceServiceLogger(config),
): VoiceServiceInstance {
  const redis = config.voiceTurnTokenSecret ? new Redis(config.redisUrl) : null;
  const turnTokenVerifier = config.voiceTurnTokenSecret && redis
    ? new VoiceTurnTokenVerifier({ secret: config.voiceTurnTokenSecret, replayGuard: new RedisTurnTokenReplayGuard(redis) })
    : undefined;

  const tokenService = new LivekitTokenService(config);
  const adapter = new DefaultLivekitAdapter();
  const meetingAudioPublisher = new MeetingAudioPublisher(config, tokenService, adapter);

  const pipelineConfigured = Boolean(
    config.googleCloudProject &&
    config.meetingAiInternalUrl &&
    config.meetingAiInternalServiceKey &&
    config.voiceControlInternalUrl &&
    config.voiceInternalServiceKey &&
    config.livekitUrl &&
    config.livekitApiKey &&
    config.livekitApiSecret,
  );
  const orchestrator = pipelineConfigured
    ? new BatchVoiceOrchestrator({
      stt: new GoogleBatchSttAdapter({
        projectId: config.googleCloudProject!,
        location: config.googleCloudLocation,
        model: config.googleSttModel,
        languageCode: config.googleSttLanguage,
        timeoutMs: config.sttTimeoutMs,
      }),
      ai: new MeetingAiClient(
        config.meetingAiInternalUrl!,
        config.meetingAiInternalServiceKey!,
        config.meetingAiTimeoutMs,
      ),
      tts: new GoogleBatchTtsAdapter({
        projectId: config.googleCloudProject!,
        location: config.googleCloudLocation,
        voiceName: config.googleTtsVoice,
        audioEncoding: config.googleTtsAudioEncoding,
        timeoutMs: config.googleTtsTimeoutMs,
      }),
      publisher: meetingAudioPublisher,
      control: new VoiceControlClient(
        config.voiceControlInternalUrl!,
        config.voiceInternalServiceKey!,
      ),
      logger,
      timeoutMs: config.pipelineTimeoutMs,
    })
    : null;

  const server = createVoiceHttpServer({
    logger,
    isReady: () => Boolean(turnTokenVerifier && orchestrator),
    turnTokenVerifier,
    onBatchAudio: orchestrator
      ? async (upload) => {
        if (!orchestrator.enqueue(upload)) {
          throw new Error('VOICE_TURN_EXPIRED');
        }
      }
      : undefined,
  });
  const shutdown = createGracefulShutdown({
    server,
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    onClose: () => {
      orchestrator?.cancelAll();
      return closeVoiceServiceResources({
        closeLivekit: () => meetingAudioPublisher.closeAll(),
        closeRedis: () => redis?.disconnect(),
      });
    },
  });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return {
    config,
    logger,
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        logger.info({ host: config.host, port: config.port }, "Voice service listening");
        resolve();
      });
    }),
  };
}

function isEntrypoint(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isEntrypoint()) {
  const service = createVoiceService();
  service.start().catch((error: unknown) => {
    service.logger.fatal({ err: error }, "Voice service failed to start");
    process.exitCode = 1;
  });
}
