import type { IncomingMessage } from "node:http";
import type { VerifiedVoiceTurnToken, VoiceTurnTokenVerifier } from "./turnTokenVerifier.js";

export const MAX_BATCH_AUDIO_BYTES = 10 * 1024 * 1024;
const SUPPORTED_AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav"]);

export interface BatchAudioUpload {
  token: VerifiedVoiceTurnToken;
  contentType: string;
  audio: Buffer;
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

function contentLength(request: IncomingMessage): number | null {
  const value = Number(request.headers["content-length"]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function readBatchAudioUpload(
  request: IncomingMessage,
  turnId: string,
  verifier: VoiceTurnTokenVerifier,
): Promise<BatchAudioUpload> {
  const token = bearerToken(request);
  if (!token) throw new Error("VOICE_TOKEN_INVALID");
  const type = request.headers["content-type"]?.split(";", 1)[0].toLowerCase();
  if (!type || !SUPPORTED_AUDIO_TYPES.has(type)) throw new Error("VOICE_AUDIO_FORMAT_UNSUPPORTED");
  const length = contentLength(request);
  if (!length || length > MAX_BATCH_AUDIO_BYTES) throw new Error("VOICE_AUDIO_TOO_LARGE");

  const verified = await verifier.verifyAndConsume(token);
  if (verified.turnId !== turnId) throw new Error("VOICE_TOKEN_INVALID");

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > MAX_BATCH_AUDIO_BYTES) throw new Error("VOICE_AUDIO_TOO_LARGE");
    chunks.push(buffer);
  }
  if (received !== length) throw new Error("VOICE_AUDIO_TOO_LARGE");
  return { token: verified, contentType: type, audio: Buffer.concat(chunks, received) };
}
