import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { VoiceServiceLogger } from "./logger.js";
import { readBatchAudioUpload, type BatchAudioUpload } from "./audioUpload.js";
import type { VoiceTurnTokenVerifier } from "./turnTokenVerifier.js";

export interface VoiceHttpServerOptions {
  logger: VoiceServiceLogger;
  isReady?: () => boolean;
  turnTokenVerifier?: VoiceTurnTokenVerifier;
  onBatchAudio?: (upload: BatchAudioUpload) => Promise<void> | void;
}

function writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  isReady: () => boolean,
  turnTokenVerifier?: VoiceTurnTokenVerifier,
  onBatchAudio?: (upload: BatchAudioUpload) => Promise<void> | void,
): Promise<void> {
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

  const match = request.url?.match(/^\/v1\/voice\/turns\/([^/]+)\/audio$/);
  if (request.method === "POST" && match) {
    if (!turnTokenVerifier || !onBatchAudio) {
      writeJson(response, 503, { code: "VOICE_INTERNAL_ERROR" });
      return;
    }
    try {
      const upload = await readBatchAudioUpload(request, decodeURIComponent(match[1]), turnTokenVerifier);
      await onBatchAudio(upload);
      writeJson(response, 202, { status: "accepted" });
    } catch (error) {
      const code = error instanceof Error ? error.message : "VOICE_INTERNAL_ERROR";
      writeJson(response, code.startsWith("VOICE_") ? 400 : 500, { code: code.startsWith("VOICE_") ? code : "VOICE_INTERNAL_ERROR" });
    }
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

export function createVoiceHttpServer(options: VoiceHttpServerOptions): Server {
  const isReady = options.isReady ?? (() => true);
  const server = createServer((request, response) => void handleRequest(request, response, isReady, options.turnTokenVerifier, options.onBatchAudio));

  server.on("clientError", (_error, socket) => {
    options.logger.warn("Rejected malformed HTTP request");
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return server;
}
