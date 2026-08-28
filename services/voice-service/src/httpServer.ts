import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { VoiceServiceLogger } from "./logger.js";

export interface VoiceHttpServerOptions {
  logger: VoiceServiceLogger;
  isReady?: () => boolean;
}

function writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  isReady: () => boolean,
): void {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, { status: "ok", service: "voice-service" });
    return;
  }

  if (request.method === "GET" && request.url === "/readyz") {
    const ready = isReady();
    writeJson(response, ready ? 200 : 503, {
      status: ready ? "ready" : "not_ready",
      service: "voice-service",
    });
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

export function createVoiceHttpServer(options: VoiceHttpServerOptions): Server {
  const isReady = options.isReady ?? (() => true);
  const server = createServer((request, response) => handleRequest(request, response, isReady));

  server.on("clientError", (_error, socket) => {
    options.logger.warn("Rejected malformed HTTP request");
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return server;
}
