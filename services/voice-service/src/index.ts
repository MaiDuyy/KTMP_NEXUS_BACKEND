import { fileURLToPath } from "node:url";
import { loadVoiceServiceConfig, type VoiceServiceConfig } from "./config.js";
import { createVoiceHttpServer } from "./httpServer.js";
import { createVoiceServiceLogger, type VoiceServiceLogger } from "./logger.js";
import { createGracefulShutdown } from "./shutdown.js";

export interface VoiceServiceInstance {
  config: VoiceServiceConfig;
  logger: VoiceServiceLogger;
  start: () => Promise<void>;
}

export function createVoiceService(
  config: VoiceServiceConfig = loadVoiceServiceConfig(),
  logger: VoiceServiceLogger = createVoiceServiceLogger(config),
): VoiceServiceInstance {
  const server = createVoiceHttpServer({ logger });
  const shutdown = createGracefulShutdown({
    server,
    logger,
    timeoutMs: config.shutdownTimeoutMs,
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
