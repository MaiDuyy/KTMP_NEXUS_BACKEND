import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from 'node:crypto';
import type { VoiceServiceLogger } from "./logger.js";
import { readBatchAudioUpload, type BatchAudioUpload } from "./audioUpload.js";
import type { VoiceTurnTokenVerifier } from "./turnTokenVerifier.js";
import { attachVoiceWebSocketServer, type VoiceWebSocketServerOptions } from './streaming/voiceWebSocketServer.js';

export interface VoiceHttpServerOptions {
  logger: VoiceServiceLogger;
  isReady?: () => boolean;
  turnTokenVerifier?: VoiceTurnTokenVerifier;
  onBatchAudio?: (upload: BatchAudioUpload) => Promise<void> | void;
  internalServiceKey?: string | null;
  onMeetingCleanup?: (meetingSessionId: string, cleanupId: string) => Promise<void>;
  featureEnabled?: boolean;
  metrics?: { contentType: string; render(): Promise<string> };
  streaming?: VoiceWebSocketServerOptions;
}

function internalAuthorized(request: IncomingMessage, expected?: string | null): boolean {
  const provided = request.headers['x-voice-internal-service-key'];
  if (!expected || typeof provided !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeMetrics(response: ServerResponse, contentType: string, body: string): void {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentType,
  });
  response.end(body);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  isReady: () => boolean,
  turnTokenVerifier?: VoiceTurnTokenVerifier,
  onBatchAudio?: (upload: BatchAudioUpload) => Promise<void> | void,
  internalServiceKey?: string | null,
  onMeetingCleanup?: (meetingSessionId: string, cleanupId: string) => Promise<void>,
  featureEnabled = true,
  metrics?: { contentType: string; render(): Promise<string> },
): Promise<void> {
  if (request.method === 'GET' && request.url === '/internal/voice/metrics') {
    if (!metrics) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }
    if (!internalAuthorized(request, internalServiceKey)) {
      writeJson(response, 401, { code: 'VOICE_INTERNAL_UNAUTHORIZED' });
      return;
    }
    writeMetrics(response, metrics.contentType, await metrics.render());
    return;
  }

  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, { status: "ok", service: "voice-service" });
    return;
  }

  const cleanupMatch = request.url?.match(/^\/internal\/voice\/meetings\/([^/]+)\/cleanup$/);
  if (request.method === 'POST' && cleanupMatch) {
    if (!internalAuthorized(request, internalServiceKey)) {
      writeJson(response, 401, { code: 'VOICE_INTERNAL_UNAUTHORIZED' });
      return;
    }
    if (!onMeetingCleanup) {
      writeJson(response, 503, { code: 'VOICE_INTERNAL_ERROR' });
      return;
    }
    const cleanupId = request.headers['x-voice-cleanup-id'];
    if (typeof cleanupId !== 'string' || cleanupId.length === 0 || cleanupId.length > 256) {
      writeJson(response, 400, { code: 'VOICE_INTERNAL_ERROR' });
      return;
    }
    try {
      await onMeetingCleanup(decodeURIComponent(cleanupMatch[1]), cleanupId);
      writeJson(response, 200, { status: 'cleaned' });
    } catch {
      writeJson(response, 503, { code: 'VOICE_INTERNAL_ERROR' });
    }
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
    if (!featureEnabled) {
      writeJson(response, 503, { code: 'VOICE_FEATURE_DISABLED' });
      return;
    }
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
  const server = createServer((request, response) => void handleRequest(
    request,
    response,
    isReady,
    options.turnTokenVerifier,
    options.onBatchAudio,
    options.internalServiceKey,
    options.onMeetingCleanup,
    options.featureEnabled,
    options.metrics,
  ));

  server.on("clientError", (_error, socket) => {
    options.logger.warn("Rejected malformed HTTP request");
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  if (options.streaming) attachVoiceWebSocketServer(server, options.streaming);

  return server;
}
