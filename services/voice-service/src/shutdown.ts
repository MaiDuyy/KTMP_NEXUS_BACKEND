import type { VoiceServiceLogger } from "./logger.js";

export interface ClosableServer {
  close(callback: (error?: Error) => void): unknown;
}

export interface GracefulShutdownOptions {
  server: ClosableServer;
  logger: VoiceServiceLogger;
  timeoutMs: number;
  exit?: (code: number) => void;
  onClose?: () => Promise<void> | void;
}

function closeServer(server: ClosableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export function createGracefulShutdown(options: GracefulShutdownOptions): (signal: NodeJS.Signals) => Promise<void> {
  const exit = options.exit ?? ((code) => process.exit(code));
  let shutdown: Promise<void> | undefined;

  return (signal: NodeJS.Signals): Promise<void> => {
    if (shutdown) {
      return shutdown;
    }

    shutdown = (async () => {
      options.logger.info({ signal }, "Voice service shutdown started");
      const forceExit = setTimeout(() => {
        options.logger.error({ signal }, "Voice service shutdown timed out");
        exit(1);
      }, options.timeoutMs);
      forceExit.unref();

      try {
        await closeServer(options.server);
        await options.onClose?.();
        clearTimeout(forceExit);
        options.logger.info({ signal }, "Voice service shutdown completed");
        exit(0);
      } catch (error) {
        clearTimeout(forceExit);
        options.logger.error({ err: error, signal }, "Voice service shutdown failed");
        exit(1);
      }
    })();

    return shutdown;
  };
}
