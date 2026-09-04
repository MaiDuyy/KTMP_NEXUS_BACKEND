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
import { MeetingCleanupCoordinator } from './meetingCleanupCoordinator.js';
import { VoiceServiceMetrics } from './voiceMetrics.js';
import { GoogleStreamingSttAdapter } from './streaming/googleStreamingStt.js';
import { StreamingVoiceSinkFactory } from './streaming/streamingVoiceSink.js';
import { CachedSpeechAdaptationProvider, ConfiguredSpeechPhraseSource } from './streaming/speechAdaptation.js';
import { GoogleStreamingTtsAdapter } from './streaming/googleStreamingTts.js';
import { StreamingOutputOrchestrator } from './streaming/streamingOutputOrchestrator.js';
import { StreamingMeetingAudioPublisher } from './livekit/StreamingMeetingAudioPublisher.js';
import { setResilienceObserver, type ProviderResilienceConfig } from './resilience.js';

export interface VoiceServiceInstance {
  config: VoiceServiceConfig;
  logger: VoiceServiceLogger;
  start: () => Promise<void>;
}

export function createVoiceService(
  config: VoiceServiceConfig = loadVoiceServiceConfig(),
  logger: VoiceServiceLogger = createVoiceServiceLogger(config),
): VoiceServiceInstance {
  const voiceMetrics = config.voiceMetricsEnabled ? new VoiceServiceMetrics() : undefined;
  const unsubscribeResilience = voiceMetrics ? setResilienceObserver(voiceMetrics) : undefined;

  const redis = config.meetingVoiceEnabled && config.voiceTurnTokenSecret ? new Redis(config.redisUrl) : null;
  const turnTokenVerifier = config.voiceTurnTokenSecret && redis
    ? new VoiceTurnTokenVerifier({ secret: config.voiceTurnTokenSecret, replayGuard: new RedisTurnTokenReplayGuard(redis) })
    : undefined;

  const tokenService = new LivekitTokenService(config);
  const adapter = new DefaultLivekitAdapter();
  const streamingAdapter = new DefaultLivekitAdapter();
  const meetingAudioPublisher = new MeetingAudioPublisher(config, tokenService, adapter);
  const streamingAudioPublisher = new StreamingMeetingAudioPublisher(config, tokenService, streamingAdapter);

  const pipelineConfigured = config.meetingVoiceEnabled && Boolean(
    config.googleCloudProject &&
    config.meetingAiInternalUrl &&
    config.meetingAiInternalServiceKey &&
    config.voiceControlInternalUrl &&
    config.voiceInternalServiceKey &&
    config.livekitUrl &&
    config.livekitApiKey &&
    config.livekitApiSecret,
  );
  const resilienceConfig: ProviderResilienceConfig = {
    circuitBreakerFailureThreshold: config.circuitBreakerFailureThreshold,
    circuitBreakerOpenDurationMs: config.circuitBreakerOpenDurationMs,
    circuitBreakerHalfOpenProbeLimit: config.circuitBreakerHalfOpenProbeLimit,
    circuitBreakerFailureWindowMs: config.circuitBreakerFailureWindowMs,
    providerMaxRetryAttempts: config.providerMaxRetryAttempts,
    providerRetryBaseBackoffMs: config.providerRetryBaseBackoffMs,
    providerRetryMaxBackoffMs: config.providerRetryMaxBackoffMs,
  };
  const meetingAiClient = config.meetingAiInternalUrl && config.meetingAiInternalServiceKey
    ? new MeetingAiClient(
      config.meetingAiInternalUrl,
      config.meetingAiInternalServiceKey,
      config.meetingAiTimeoutMs,
      config.meetingAiStreamFirstEventTimeoutMs,
      config.meetingAiStreamIdleEventTimeoutMs,
      resilienceConfig,
    )
    : null;
  const voiceControlClient = config.voiceControlInternalUrl && config.voiceInternalServiceKey
    ? new VoiceControlClient(config.voiceControlInternalUrl, config.voiceInternalServiceKey)
    : null;
  const streamingOutput = pipelineConfigured && config.voiceStreamingOutputEnabled && config.voiceStreamingTtsEnabled && meetingAiClient
    ? new StreamingOutputOrchestrator(
      new GoogleStreamingTtsAdapter({
        projectId: config.googleCloudProject!,
        location: config.googleStreamingTtsLocation,
        voiceName: config.googleStreamingTtsVoice,
        sampleRateHertz: config.googleStreamingTtsSampleRateHertz,
        firstAudioTimeoutMs: config.googleStreamingTtsFirstAudioTimeoutMs,
        idleAudioTimeoutMs: config.googleStreamingTtsIdleAudioTimeoutMs,
        totalTimeoutMs: config.googleStreamingTtsTotalTimeoutMs,
        maximumQueuedBytes: config.googleStreamingTtsMaxQueuedBytes,
      }, resilienceConfig),
      streamingAudioPublisher,
      {
        minimumChars: config.voiceStreamingTtsSentenceMinimumChars,
        targetChars: config.voiceStreamingTtsSentenceTargetChars,
        maximumChars: config.voiceStreamingTtsSentenceMaximumChars,
        maximumBytes: config.googleStreamingTtsMaxQueuedBytes,
        flushTimeoutMs: config.voiceStreamingTtsSentenceFlushTimeoutMs,
      },
    )
    : null;
  const orchestrator = pipelineConfigured
    ? new BatchVoiceOrchestrator({
      stt: new GoogleBatchSttAdapter({
        projectId: config.googleCloudProject!,
        location: config.googleCloudLocation,
        model: config.googleSttModel,
        languageCode: config.googleSttLanguage,
        timeoutMs: config.sttTimeoutMs,
      }, resilienceConfig),
      ai: meetingAiClient!,
      tts: new GoogleBatchTtsAdapter({
        projectId: config.googleCloudProject!,
        location: config.googleCloudLocation,
        voiceName: config.googleTtsVoice,
        audioEncoding: config.googleTtsAudioEncoding,
        timeoutMs: config.googleTtsTimeoutMs,
      }, resilienceConfig),
      publisher: meetingAudioPublisher,
      control: voiceControlClient!,
      logger,
      timeoutMs: config.pipelineTimeoutMs,
      metrics: voiceMetrics,
      streamingOutput,
    })
    : null;
  const streamingSinkFactory = config.voiceStreamingEnabled && orchestrator && voiceControlClient && config.googleCloudProject
    ? new StreamingVoiceSinkFactory({
      stt: new GoogleStreamingSttAdapter({
        projectId: config.googleCloudProject,
        location: config.googleStreamingSttLocation,
        model: config.googleStreamingSttModel,
        languageCode: config.googleSttLanguage,
        timeoutMs: config.streamingSttTimeoutMs,
      }, resilienceConfig),
      control: voiceControlClient,
      pipeline: orchestrator,
      adaptation: new CachedSpeechAdaptationProvider(
        new ConfiguredSpeechPhraseSource(config.googleStreamingSttPhrases),
      ),
      metrics: voiceMetrics,
    })
    : null;
  const meetingCleanupCoordinator = meetingAiClient
    ? new MeetingCleanupCoordinator({
      orchestrator,
      streaming: streamingSinkFactory,
      publisher: meetingAudioPublisher,
      streamingPublisher: streamingAudioPublisher,
      meetingAi: meetingAiClient,
      logger,
      timeoutMs: config.meetingCleanupTimeoutMs,
      metrics: voiceMetrics,
    })
    : null;

  const server = createVoiceHttpServer({
    logger,
    isReady: () => !config.meetingVoiceEnabled || Boolean(
      turnTokenVerifier && orchestrator && (!config.voiceStreamingEnabled || streamingSinkFactory),
    ),
    turnTokenVerifier,
    internalServiceKey: config.voiceInternalServiceKey,
    featureEnabled: config.meetingVoiceEnabled,
    metrics: voiceMetrics,
    onMeetingCleanup: meetingCleanupCoordinator
      ? (meetingSessionId, cleanupId) => meetingCleanupCoordinator.cleanup(meetingSessionId, cleanupId)
      : undefined,
    onTurnCancel: orchestrator || streamingSinkFactory
      ? async (meetingSessionId, turnId) => {
        const results = await Promise.allSettled([
          streamingSinkFactory?.cancelTurn(meetingSessionId, turnId) ?? Promise.resolve(false),
          orchestrator?.cancelTurn(meetingSessionId, turnId) ?? Promise.resolve(false),
        ]);
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) throw new AggregateError(failures, 'VOICE_TURN_CANCEL_FAILED');
      }
      : undefined,
    onBatchAudio: orchestrator
      ? async (upload) => {
        if (!orchestrator.enqueue(upload)) {
          throw new Error('VOICE_TURN_EXPIRED');
        }
      }
      : undefined,
    streaming: config.voiceStreamingEnabled && turnTokenVerifier && streamingSinkFactory
      ? {
        logger,
        verifier: turnTokenVerifier,
        sinkFactory: streamingSinkFactory,
        allowedOrigins: config.voiceStreamAllowedOrigins,
        authTimeoutMs: config.voiceStreamAuthTimeoutMs,
        idleTimeoutMs: config.voiceStreamIdleTimeoutMs,
        maxDurationMs: config.voiceStreamMaxDurationMs,
        maxQueuedBytes: config.voiceStreamMaxQueuedBytes,
        metrics: voiceMetrics,
      }
      : undefined,
  });
  const shutdown = createGracefulShutdown({
    server,
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    onClose: async () => {
      unsubscribeResilience?.();
      await Promise.allSettled([
        streamingSinkFactory?.cancelAll() ?? Promise.resolve(),
        orchestrator?.cancelAllAndWait() ?? Promise.resolve(),
      ]);
      return closeVoiceServiceResources({
        closeLivekit: async () => {
          await Promise.all([meetingAudioPublisher.closeAll(), streamingAudioPublisher.closeAll()]);
        },
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
