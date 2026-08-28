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

export function loadVoiceServiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceServiceConfig {
  const nodeEnv = readNonEmptyString(env.NODE_ENV, "development", "NODE_ENV");
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
  };
}
