import pino, { type Logger } from "pino";
import type { VoiceServiceConfig } from "./config.js";

export type VoiceServiceLogger = Pick<Logger, "info" | "warn" | "error" | "fatal">;

export function createVoiceServiceLogger(config: VoiceServiceConfig): VoiceServiceLogger {
  return pino({
    level: config.logLevel,
    base: {
      service: "voice-service",
      environment: config.nodeEnv,
    },
    redact: {
      paths: [
        "authorization",
        "headers.authorization",
        "headers.x-meeting-ai-service-key",
        "turnToken",
        "body",
        "audio",
        "transcript",
      ],
      remove: true,
    },
  });
}
