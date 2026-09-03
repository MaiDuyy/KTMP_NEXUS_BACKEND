export interface VoiceServiceConfig {
  meetingVoiceEnabled: boolean;
  voiceMetricsEnabled: boolean;
  voiceStreamingEnabled: boolean;
  voiceStreamAllowedOrigins: ReadonlySet<string>;
  voiceStreamAuthTimeoutMs: number;
  voiceStreamIdleTimeoutMs: number;
  voiceStreamMaxDurationMs: number;
  voiceStreamMaxQueuedBytes: number;
  host: string;
  port: number;
  shutdownTimeoutMs: number;
  logLevel: string;
  nodeEnv: string;
  redisUrl: string;
  voiceTurnTokenSecret: string | null;
  googleCloudProject: string | null;
  googleCloudLocation: string;
  googleSttModel: string;
  googleSttLanguage: string;
  sttTimeoutMs: number;
  streamingSttTimeoutMs: number;
  googleStreamingSttLocation: string;
  googleStreamingSttModel: string;
  googleStreamingSttPhrases: readonly string[];
  googleTtsVoice: string;
  googleTtsAudioEncoding: string;
  googleTtsTimeoutMs: number;
  voiceStreamingTtsEnabled: boolean;
  voiceStreamingOutputEnabled: boolean;
  voiceStreamingOutputMaxTotalPcmBytes: number;
  googleStreamingTtsLocation: string;
  googleStreamingTtsVoice: string;
  googleStreamingTtsSampleRateHertz: number;
  googleStreamingTtsFirstAudioTimeoutMs: number;
  googleStreamingTtsIdleAudioTimeoutMs: number;
  googleStreamingTtsTotalTimeoutMs: number;
  googleStreamingTtsMaxQueuedBytes: number;
  voiceStreamingTtsSentenceMinimumChars: number;
  voiceStreamingTtsSentenceTargetChars: number;
  voiceStreamingTtsSentenceMaximumChars: number;
  voiceStreamingTtsSentenceFlushTimeoutMs: number;
  meetingAiInternalUrl: string | null;
  meetingAiInternalServiceKey: string | null;
  meetingAiTimeoutMs: number;
  meetingAiStreamFirstEventTimeoutMs: number;
  meetingAiStreamIdleEventTimeoutMs: number;
  voiceControlInternalUrl: string | null;
  voiceInternalServiceKey: string | null;
  pipelineTimeoutMs: number;
  meetingCleanupTimeoutMs: number;
  livekitUrl: string | null;
  livekitApiKey: string | null;
  livekitApiSecret: string | null;
  livekitAiParticipantName: string;
  livekitConnectTimeoutMs: number;
  livekitPlayoutTimeoutMs: number;
}

const DEFAULT_PORT = 3035;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function readBoolean(value: string | undefined, fallback: boolean, variableName: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${variableName} must be true, false, 1, or 0`);
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${variableName} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${variableName} must be a positive integer`);
  }

  return parsed;
}

function readBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  variableName: string,
  maximum: number,
): number {
  const parsed = readPositiveInteger(value, fallback, variableName);
  if (parsed > maximum) {
    throw new Error(`${variableName} must be less than or equal to ${maximum}`);
  }
  return parsed;
}

function readStreamingPhrases(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  const phrases: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of value.split(',')) {
    const phrase = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!phrase) continue;
    const bytes = Buffer.byteLength(phrase, 'utf8');
    if (bytes > 100) throw new Error('GOOGLE_STREAMING_STT_PHRASES contains a phrase larger than 100 bytes');
    const key = phrase.toLocaleLowerCase('vi-VN');
    if (seen.has(key)) continue;
    if (phrases.length >= 100 || totalBytes + bytes > 5_000) {
      throw new Error('GOOGLE_STREAMING_STT_PHRASES exceeds 100 phrases or 5000 bytes');
    }
    seen.add(key);
    phrases.push(phrase);
    totalBytes += bytes;
  }
  return phrases;
}

function readNonEmptyString(value: string | undefined, fallback: string, variableName: string): string {
  const resolved = value ?? fallback;
  if (resolved.trim().length === 0) {
    throw new Error(`${variableName} must not be empty`);
  }

  return resolved;
}

function readOptionalVoiceTurnTokenSecret(value: string | undefined, nodeEnv: string): string | null {
  if (value === undefined || value === "") {
    if (nodeEnv === "production") {
      throw new Error("VOICE_TURN_TOKEN_SECRET is required in production");
    }

    return null;
  }

  if (value.trim() !== value || value.length < 32) {
    throw new Error("VOICE_TURN_TOKEN_SECRET must contain at least 32 non-whitespace characters");
  }

  return value;
}

function readOptionalServiceSecret(value: string | undefined, variableName: string, nodeEnv: string): string | null {
  if (value === undefined || value === '') {
    if (nodeEnv === 'production') {
      throw new Error(`${variableName} is required in production`);
    }
    return null;
  }
  if (value.trim() !== value || value.length < 32) {
    throw new Error(`${variableName} must contain at least 32 non-whitespace characters`);
  }
  return value;
}

function readOptionalHttpUrl(value: string | undefined, variableName: string, nodeEnv: string): string | null {
  if (value === undefined || value === '') {
    if (nodeEnv === 'production') {
      throw new Error(`${variableName} is required in production`);
    }
    return null;
  }
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${variableName} must use http or https`);
  }
  return url.toString();
}

function readOrigins(value: string | undefined, production: boolean, enabled: boolean): ReadonlySet<string> {
  const source = value === undefined || value.trim() === ''
    ? (production ? [] : ['http://localhost:3000'])
    : value.split(',').map((item) => item.trim()).filter(Boolean);
  const origins = new Set<string>();
  for (const item of source) {
    const url = new URL(item);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== item) {
      throw new Error('VOICE_STREAM_ALLOWED_ORIGINS must contain comma-separated HTTP origins');
    }
    origins.add(item);
  }
  if (production && enabled && origins.size === 0) {
    throw new Error('VOICE_STREAM_ALLOWED_ORIGINS is required when streaming is enabled in production');
  }
  return origins;
}

function readLiveKitCredentials(env: NodeJS.ProcessEnv, nodeEnv: string): { livekitUrl: string | null; livekitApiKey: string | null; livekitApiSecret: string | null } {
  const url = (env.LIVEKIT_URL ?? "").trim();
  const key = (env.LIVEKIT_API_KEY ?? "").trim();
  const secret = (env.LIVEKIT_API_SECRET ?? "").trim();

  const missingCount = [url, key, secret].filter(x => x === "").length;

  if (missingCount === 3) {
    if (nodeEnv === "production") {
      throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required in production");
    }
    return { livekitUrl: null, livekitApiKey: null, livekitApiSecret: null };
  }

  if (missingCount > 0) {
    throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must all be provided together");
  }

  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    throw new Error("LIVEKIT_URL must start with ws:// or wss://");
  }

  return { livekitUrl: url, livekitApiKey: key, livekitApiSecret: secret };
}

export function loadVoiceServiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceServiceConfig {
  const nodeEnv = readNonEmptyString(env.NODE_ENV, "development", "NODE_ENV");
  const lkCredentials = readLiveKitCredentials(env, nodeEnv);
  const voiceStreamingEnabled = readBoolean(env.VOICE_STREAMING_ENABLED, false, 'VOICE_STREAMING_ENABLED');

  const config: VoiceServiceConfig = {
    meetingVoiceEnabled: readBoolean(env.MEETING_VOICE_ENABLED, nodeEnv !== 'production', 'MEETING_VOICE_ENABLED'),
    voiceMetricsEnabled: readBoolean(env.VOICE_METRICS_ENABLED, nodeEnv !== 'production', 'VOICE_METRICS_ENABLED'),
    voiceStreamingEnabled,
    voiceStreamAllowedOrigins: readOrigins(env.VOICE_STREAM_ALLOWED_ORIGINS, nodeEnv === 'production', voiceStreamingEnabled),
    voiceStreamAuthTimeoutMs: readPositiveInteger(env.VOICE_STREAM_AUTH_TIMEOUT_MS, 5_000, 'VOICE_STREAM_AUTH_TIMEOUT_MS'),
    voiceStreamIdleTimeoutMs: readPositiveInteger(env.VOICE_STREAM_IDLE_TIMEOUT_MS, 15_000, 'VOICE_STREAM_IDLE_TIMEOUT_MS'),
    voiceStreamMaxDurationMs: readBoundedPositiveInteger(
      env.VOICE_STREAM_MAX_DURATION_MS,
      60_000,
      'VOICE_STREAM_MAX_DURATION_MS',
      60_000,
    ),
    voiceStreamMaxQueuedBytes: readPositiveInteger(env.VOICE_STREAM_MAX_QUEUED_BYTES, 256 * 1024, 'VOICE_STREAM_MAX_QUEUED_BYTES'),
    host: readNonEmptyString(env.VOICE_SERVICE_HOST, "0.0.0.0", "VOICE_SERVICE_HOST"),
    port: readPositiveInteger(env.VOICE_SERVICE_PORT ?? env.PORT, DEFAULT_PORT, "VOICE_SERVICE_PORT"),
    shutdownTimeoutMs: readPositiveInteger(
      env.VOICE_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "VOICE_SHUTDOWN_TIMEOUT_MS",
    ),
    logLevel: readNonEmptyString(env.LOG_LEVEL, nodeEnv === "production" ? "warn" : "info", "LOG_LEVEL"),
    nodeEnv,
    redisUrl: readNonEmptyString(env.REDIS_URL, "redis://localhost:6379", "REDIS_URL"),
    voiceTurnTokenSecret: readOptionalVoiceTurnTokenSecret(env.VOICE_TURN_TOKEN_SECRET, nodeEnv),
    googleCloudProject: env.GOOGLE_CLOUD_PROJECT || null,
    googleCloudLocation: readNonEmptyString(env.GOOGLE_CLOUD_LOCATION, "asia-southeast1", "GOOGLE_CLOUD_LOCATION"),
    googleSttModel: readNonEmptyString(env.GOOGLE_STT_MODEL, "chirp_3", "GOOGLE_STT_MODEL"),
    googleSttLanguage: readNonEmptyString(env.GOOGLE_STT_LANGUAGE, "vi-VN", "GOOGLE_STT_LANGUAGE"),
    sttTimeoutMs: readPositiveInteger(env.GOOGLE_STT_TIMEOUT_MS, 15_000, "GOOGLE_STT_TIMEOUT_MS"),
    streamingSttTimeoutMs: readPositiveInteger(env.GOOGLE_STREAMING_STT_TIMEOUT_MS, 70_000, 'GOOGLE_STREAMING_STT_TIMEOUT_MS'),
    googleStreamingSttLocation: readNonEmptyString(env.GOOGLE_STREAMING_STT_LOCATION, 'us', 'GOOGLE_STREAMING_STT_LOCATION'),
    googleStreamingSttModel: readNonEmptyString(env.GOOGLE_STREAMING_STT_MODEL, 'chirp_3', 'GOOGLE_STREAMING_STT_MODEL'),
    googleStreamingSttPhrases: readStreamingPhrases(env.GOOGLE_STREAMING_STT_PHRASES),
    googleTtsVoice: readNonEmptyString(env.GOOGLE_TTS_VOICE, "vi-VN-Chirp3-HD-Charon", "GOOGLE_TTS_VOICE"),
    googleTtsAudioEncoding: readNonEmptyString(env.GOOGLE_TTS_AUDIO_ENCODING, "LINEAR16", "GOOGLE_TTS_AUDIO_ENCODING"),
    googleTtsTimeoutMs: readPositiveInteger(env.GOOGLE_TTS_TIMEOUT_MS, 15_000, "GOOGLE_TTS_TIMEOUT_MS"),
    voiceStreamingTtsEnabled: readBoolean(env.VOICE_STREAMING_TTS_ENABLED, false, 'VOICE_STREAMING_TTS_ENABLED'),
    voiceStreamingOutputEnabled: readBoolean(env.VOICE_STREAMING_OUTPUT_ENABLED, false, 'VOICE_STREAMING_OUTPUT_ENABLED'),
    voiceStreamingOutputMaxTotalPcmBytes: readBoundedPositiveInteger(
      env.VOICE_STREAMING_OUTPUT_MAX_TOTAL_PCM_BYTES,
      8 * 1024 * 1024,
      'VOICE_STREAMING_OUTPUT_MAX_TOTAL_PCM_BYTES',
      64 * 1024 * 1024,
    ),
    googleStreamingTtsLocation: readNonEmptyString(
      env.GOOGLE_STREAMING_TTS_LOCATION,
      'asia-southeast1',
      'GOOGLE_STREAMING_TTS_LOCATION',
    ),
    googleStreamingTtsVoice: readNonEmptyString(
      env.GOOGLE_STREAMING_TTS_VOICE,
      env.GOOGLE_TTS_VOICE ?? 'vi-VN-Chirp3-HD-Charon',
      'GOOGLE_STREAMING_TTS_VOICE',
    ),
    googleStreamingTtsSampleRateHertz: readBoundedPositiveInteger(
      env.GOOGLE_STREAMING_TTS_SAMPLE_RATE_HERTZ,
      24_000,
      'GOOGLE_STREAMING_TTS_SAMPLE_RATE_HERTZ',
      48_000,
    ),
    googleStreamingTtsFirstAudioTimeoutMs: readPositiveInteger(
      env.GOOGLE_STREAMING_TTS_FIRST_AUDIO_TIMEOUT_MS,
      10_000,
      'GOOGLE_STREAMING_TTS_FIRST_AUDIO_TIMEOUT_MS',
    ),
    googleStreamingTtsIdleAudioTimeoutMs: readPositiveInteger(
      env.GOOGLE_STREAMING_TTS_IDLE_AUDIO_TIMEOUT_MS,
      15_000,
      'GOOGLE_STREAMING_TTS_IDLE_AUDIO_TIMEOUT_MS',
    ),
    googleStreamingTtsTotalTimeoutMs: readPositiveInteger(
      env.GOOGLE_STREAMING_TTS_TOTAL_TIMEOUT_MS,
      60_000,
      'GOOGLE_STREAMING_TTS_TOTAL_TIMEOUT_MS',
    ),
    googleStreamingTtsMaxQueuedBytes: readPositiveInteger(
      env.GOOGLE_STREAMING_TTS_MAX_QUEUED_BYTES,
      512 * 1024,
      'GOOGLE_STREAMING_TTS_MAX_QUEUED_BYTES',
    ),
    voiceStreamingTtsSentenceMinimumChars: readPositiveInteger(
      env.VOICE_STREAMING_TTS_SENTENCE_MINIMUM_CHARS,
      24,
      'VOICE_STREAMING_TTS_SENTENCE_MINIMUM_CHARS',
    ),
    voiceStreamingTtsSentenceTargetChars: readPositiveInteger(
      env.VOICE_STREAMING_TTS_SENTENCE_TARGET_CHARS,
      160,
      'VOICE_STREAMING_TTS_SENTENCE_TARGET_CHARS',
    ),
    voiceStreamingTtsSentenceMaximumChars: readPositiveInteger(
      env.VOICE_STREAMING_TTS_SENTENCE_MAXIMUM_CHARS,
      280,
      'VOICE_STREAMING_TTS_SENTENCE_MAXIMUM_CHARS',
    ),
    voiceStreamingTtsSentenceFlushTimeoutMs: readPositiveInteger(
      env.VOICE_STREAMING_TTS_SENTENCE_FLUSH_TIMEOUT_MS,
      800,
      'VOICE_STREAMING_TTS_SENTENCE_FLUSH_TIMEOUT_MS',
    ),
    meetingAiInternalUrl: readOptionalHttpUrl(env.MEETING_AI_INTERNAL_URL, 'MEETING_AI_INTERNAL_URL', nodeEnv),
    meetingAiInternalServiceKey: readOptionalServiceSecret(
      env.MEETING_AI_INTERNAL_SERVICE_KEY,
      'MEETING_AI_INTERNAL_SERVICE_KEY',
      nodeEnv,
    ),
    meetingAiTimeoutMs: readPositiveInteger(env.MEETING_AI_TIMEOUT_MS, 45_000, 'MEETING_AI_TIMEOUT_MS'),
    meetingAiStreamFirstEventTimeoutMs: readPositiveInteger(
      env.MEETING_AI_STREAM_FIRST_EVENT_TIMEOUT_MS,
      10_000,
      'MEETING_AI_STREAM_FIRST_EVENT_TIMEOUT_MS',
    ),
    meetingAiStreamIdleEventTimeoutMs: readPositiveInteger(
      env.MEETING_AI_STREAM_IDLE_EVENT_TIMEOUT_MS,
      20_000,
      'MEETING_AI_STREAM_IDLE_EVENT_TIMEOUT_MS',
    ),
    voiceControlInternalUrl: readOptionalHttpUrl(env.VOICE_CONTROL_INTERNAL_URL, 'VOICE_CONTROL_INTERNAL_URL', nodeEnv),
    voiceInternalServiceKey: readOptionalServiceSecret(
      env.VOICE_INTERNAL_SERVICE_KEY,
      'VOICE_INTERNAL_SERVICE_KEY',
      nodeEnv,
    ),
    pipelineTimeoutMs: readPositiveInteger(env.VOICE_PIPELINE_TIMEOUT_MS, 150_000, 'VOICE_PIPELINE_TIMEOUT_MS'),
    meetingCleanupTimeoutMs: readPositiveInteger(
      env.VOICE_MEETING_CLEANUP_TIMEOUT_MS,
      30_000,
      'VOICE_MEETING_CLEANUP_TIMEOUT_MS',
    ),
    livekitUrl: lkCredentials.livekitUrl,
    livekitApiKey: lkCredentials.livekitApiKey,
    livekitApiSecret: lkCredentials.livekitApiSecret,
    livekitAiParticipantName: readNonEmptyString(env.LIVEKIT_AI_PARTICIPANT_NAME, "Nexus AI", "LIVEKIT_AI_PARTICIPANT_NAME"),
    livekitConnectTimeoutMs: readPositiveInteger(env.LIVEKIT_CONNECT_TIMEOUT_MS, 15_000, "LIVEKIT_CONNECT_TIMEOUT_MS"),
    livekitPlayoutTimeoutMs: readPositiveInteger(env.LIVEKIT_PLAYOUT_TIMEOUT_MS, 70_000, "LIVEKIT_PLAYOUT_TIMEOUT_MS"),
  };

  if (
    config.voiceStreamingTtsSentenceMinimumChars > config.voiceStreamingTtsSentenceTargetChars
    || config.voiceStreamingTtsSentenceTargetChars > config.voiceStreamingTtsSentenceMaximumChars
  ) {
    throw new Error(
      'VOICE_STREAMING_TTS_SENTENCE_MINIMUM_CHARS, VOICE_STREAMING_TTS_SENTENCE_TARGET_CHARS, and VOICE_STREAMING_TTS_SENTENCE_MAXIMUM_CHARS must be ordered',
    );
  }

  return config;
}
