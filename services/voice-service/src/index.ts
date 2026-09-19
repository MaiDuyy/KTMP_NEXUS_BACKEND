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
import { createSelectedVoiceProviders } from './providers/providerFactory.js';
import { ElevenLabsBatchSttAdapter } from './providers/elevenlabs/elevenLabsBatchStt.js';
import { ElevenLabsBatchTtsAdapter } from './providers/elevenlabs/elevenLabsBatchTts.js';
import { ElevenLabsStreamingSttAdapter } from './providers/elevenlabs/elevenLabsStreamingStt.js';
import { ElevenLabsStreamingTtsAdapter } from './providers/elevenlabs/elevenLabsStreamingTts.js';
import { MAX_BATCH_AUDIO_BYTES } from './audioUpload.js';

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

  const selectedProviderCredentialsConfigured = Boolean(
    (config.voiceSttProvider !== 'google' || config.googleCloudProject) &&
    (config.voiceTtsProvider !== 'google' || config.googleCloudProject) &&
    (config.voiceSttProvider !== 'elevenlabs' || config.elevenLabsApiKey) &&
    (config.voiceTtsProvider !== 'elevenlabs' || (config.elevenLabsApiKey && config.elevenLabsTtsVoiceId)),
  );
  const pipelineConfigured = config.meetingVoiceEnabled && Boolean(
    selectedProviderCredentialsConfigured &&
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
  const providers = pipelineConfigured
    ? createSelectedVoiceProviders(
      { sttProvider: config.voiceSttProvider, ttsProvider: config.voiceTtsProvider },
      {
        google: {
          createStt: () => ({
            batch: new GoogleBatchSttAdapter({
              projectId: config.googleCloudProject!,
              location: config.googleCloudLocation,
              model: config.googleSttModel,
              languageCode: config.googleSttLanguage,
              timeoutMs: config.sttTimeoutMs,
            }, resilienceConfig),
            streaming: new GoogleStreamingSttAdapter({
              projectId: config.googleCloudProject!,
              location: config.googleStreamingSttLocation,
              model: config.googleStreamingSttModel,
              languageCode: config.googleSttLanguage,
              timeoutMs: config.streamingSttTimeoutMs,
            }, resilienceConfig),
          }),
          createTts: () => ({
            batch: new GoogleBatchTtsAdapter({
              projectId: config.googleCloudProject!,
              location: config.googleCloudLocation,
              voiceName: config.googleTtsVoice,
              audioEncoding: config.googleTtsAudioEncoding,
              timeoutMs: config.googleTtsTimeoutMs,
            }, resilienceConfig),
            streaming: new GoogleStreamingTtsAdapter({
              projectId: config.googleCloudProject!,
              location: config.googleStreamingTtsLocation,
              voiceName: config.googleStreamingTtsVoice,
              sampleRateHertz: config.googleStreamingTtsSampleRateHertz,
              firstAudioTimeoutMs: config.googleStreamingTtsFirstAudioTimeoutMs,
              idleAudioTimeoutMs: config.googleStreamingTtsIdleAudioTimeoutMs,
              totalTimeoutMs: config.googleStreamingTtsTotalTimeoutMs,
              maximumQueuedBytes: config.googleStreamingTtsMaxQueuedBytes,
            }, resilienceConfig),
          }),
        },
        elevenlabs: {
          createStt: () => ({
            batch: new ElevenLabsBatchSttAdapter({
              apiKey: config.elevenLabsApiKey!,
              apiBaseUrl: config.elevenLabsApiBaseUrl,
              model: config.elevenLabsSttModel,
              languageCode: config.elevenLabsLanguage,
              timeoutMs: config.elevenLabsRequestTimeoutMs,
              maximumInputBytes: MAX_BATCH_AUDIO_BYTES,
            }, resilienceConfig),
            streaming: new ElevenLabsStreamingSttAdapter({
              apiKey: config.elevenLabsApiKey!,
              endpoint: config.elevenLabsStreamingSttUrl,
              model: config.elevenLabsStreamingSttModel,
              languageCode: config.elevenLabsLanguage,
              timeoutMs: config.elevenLabsTotalTimeoutMs,
              maximumQueuedBytes: config.voiceStreamMaxQueuedBytes,
            }, resilienceConfig),
          }),
          createTts: () => ({
            batch: new ElevenLabsBatchTtsAdapter({
              apiKey: config.elevenLabsApiKey!,
              apiBaseUrl: config.elevenLabsApiBaseUrl,
              voiceId: config.elevenLabsTtsVoiceId!,
              model: config.elevenLabsTtsModel,
              languageCode: config.elevenLabsLanguage,
              outputFormat: config.elevenLabsOutputFormat,
              timeoutMs: config.elevenLabsRequestTimeoutMs,
              maximumOutputBytes: config.voiceStreamingOutputMaxTotalPcmBytes,
            }, resilienceConfig),
            streaming: new ElevenLabsStreamingTtsAdapter({
              apiKey: config.elevenLabsApiKey!,
              endpoint: config.elevenLabsStreamingTtsUrl,
              voiceId: config.elevenLabsTtsVoiceId!,
              model: config.elevenLabsTtsModel,
              languageCode: config.elevenLabsLanguage,
              outputFormat: config.elevenLabsOutputFormat,
              firstAudioTimeoutMs: config.elevenLabsFirstAudioTimeoutMs,
              idleAudioTimeoutMs: config.elevenLabsIdleAudioTimeoutMs,
              totalTimeoutMs: config.elevenLabsTotalTimeoutMs,
              maximumQueuedBytes: config.elevenLabsMaxQueuedBytes,
            }, resilienceConfig),
          }),
        },
      },
    )
    : null;
  const streamingTtsMaximumBytes = config.voiceTtsProvider === 'elevenlabs'
    ? config.elevenLabsMaxQueuedBytes
    : config.googleStreamingTtsMaxQueuedBytes;
  const streamingOutput = pipelineConfigured && config.voiceStreamingOutputEnabled && config.voiceStreamingTtsEnabled && meetingAiClient
    ? new StreamingOutputOrchestrator(
      providers!.tts.streaming,
      streamingAudioPublisher,
      {
        minimumChars: config.voiceStreamingTtsSentenceMinimumChars,
        targetChars: config.voiceStreamingTtsSentenceTargetChars,
        maximumChars: config.voiceStreamingTtsSentenceMaximumChars,
        maximumBytes: streamingTtsMaximumBytes,
        flushTimeoutMs: config.voiceStreamingTtsSentenceFlushTimeoutMs,
      },
    )
    : null;
  const orchestrator = pipelineConfigured
    ? new BatchVoiceOrchestrator({
      stt: providers!.stt.batch,
      ai: meetingAiClient!,
      tts: providers!.tts.batch,
      publisher: meetingAudioPublisher,
      control: voiceControlClient!,
      logger,
      timeoutMs: config.pipelineTimeoutMs,
      metrics: voiceMetrics,
      streamingOutput,
    })
    : null;
  const streamingSinkFactory = config.voiceStreamingEnabled && orchestrator && voiceControlClient && providers
    ? new StreamingVoiceSinkFactory({
      stt: providers.stt.streaming,
      control: voiceControlClient,
      pipeline: orchestrator,
      adaptation: new CachedSpeechAdaptationProvider(
        new ConfiguredSpeechPhraseSource(config.googleStreamingSttPhrases),
      ),
      metrics: voiceMetrics,
      resilienceProvider: config.voiceSttProvider === 'google' ? 'google_stt' : 'elevenlabs_stt',
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
