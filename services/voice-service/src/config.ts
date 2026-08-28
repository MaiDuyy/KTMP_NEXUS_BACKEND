export interface VoiceServiceConfig {
  host: string;
  port: number;
  shutdownTimeoutMs: number;
  logLevel: string;
  nodeEnv: string;
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

export function loadVoiceServiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceServiceConfig {
  return {
    host: readNonEmptyString(env.VOICE_SERVICE_HOST, "0.0.0.0", "VOICE_SERVICE_HOST"),
    port: readPositiveInteger(env.VOICE_SERVICE_PORT ?? env.PORT, DEFAULT_PORT, "VOICE_SERVICE_PORT"),
    shutdownTimeoutMs: readPositiveInteger(
      env.VOICE_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "VOICE_SHUTDOWN_TIMEOUT_MS",
    ),
    logLevel: readNonEmptyString(env.LOG_LEVEL, env.NODE_ENV === "production" ? "warn" : "info", "LOG_LEVEL"),
    nodeEnv: readNonEmptyString(env.NODE_ENV, "development", "NODE_ENV"),
  };
}
