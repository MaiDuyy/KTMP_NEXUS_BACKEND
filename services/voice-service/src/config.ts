export interface VoiceServiceConfig {
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
  googleTtsVoice: string;
  googleTtsAudioEncoding: string;
  googleTtsTimeoutMs: number;
  livekitUrl: string | null;
  livekitApiKey: string | null;
  livekitApiSecret: string | null;
  livekitAiParticipantName: string;
  livekitConnectTimeoutMs: number;
  livekitPlayoutTimeoutMs: number;
}

const DEFAULT_PORT = 3035;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

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

  return {
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
    googleSttModel: readNonEmptyString(env.GOOGLE_STT_MODEL, "chirp_2", "GOOGLE_STT_MODEL"),
    googleSttLanguage: readNonEmptyString(env.GOOGLE_STT_LANGUAGE, "vi-VN", "GOOGLE_STT_LANGUAGE"),
    sttTimeoutMs: readPositiveInteger(env.GOOGLE_STT_TIMEOUT_MS, 15_000, "GOOGLE_STT_TIMEOUT_MS"),
    googleTtsVoice: readNonEmptyString(env.GOOGLE_TTS_VOICE, "vi-VN-Chirp3-HD-Charon", "GOOGLE_TTS_VOICE"),
    googleTtsAudioEncoding: readNonEmptyString(env.GOOGLE_TTS_AUDIO_ENCODING, "LINEAR16", "GOOGLE_TTS_AUDIO_ENCODING"),
    googleTtsTimeoutMs: readPositiveInteger(env.GOOGLE_TTS_TIMEOUT_MS, 15_000, "GOOGLE_TTS_TIMEOUT_MS"),
    livekitUrl: lkCredentials.livekitUrl,
    livekitApiKey: lkCredentials.livekitApiKey,
    livekitApiSecret: lkCredentials.livekitApiSecret,
    livekitAiParticipantName: readNonEmptyString(env.LIVEKIT_AI_PARTICIPANT_NAME, "Nexus AI", "LIVEKIT_AI_PARTICIPANT_NAME"),
    livekitConnectTimeoutMs: readPositiveInteger(env.LIVEKIT_CONNECT_TIMEOUT_MS, 15_000, "LIVEKIT_CONNECT_TIMEOUT_MS"),
    livekitPlayoutTimeoutMs: readPositiveInteger(env.LIVEKIT_PLAYOUT_TIMEOUT_MS, 70_000, "LIVEKIT_PLAYOUT_TIMEOUT_MS"),
  };
}
