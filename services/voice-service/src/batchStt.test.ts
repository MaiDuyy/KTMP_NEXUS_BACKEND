import assert from "node:assert/strict";
import test from "node:test";
import { BatchSttError, GoogleBatchSttAdapter } from "./batchStt.js";

const config = { projectId: "project", location: "asia-southeast1", model: "chirp_2", languageCode: "vi-VN", timeoutMs: 10_000 };
test("returns final transcript and confidence", async () => {
  const client = { recognize: async () => [{ results: [{ alternatives: [{ transcript: "xin chào", confidence: 0.9 }] }] }] as [any] };
  const adapter = new GoogleBatchSttAdapter(config, client);
  assert.deepEqual(await adapter.transcribe(Buffer.from([1]), "audio/webm"), { transcript: "xin chào", confidence: 0.9 });
});
test("maps empty and timeout results", async () => {
  const empty = new GoogleBatchSttAdapter(config, { recognize: async () => [{ results: [] }] as [any] });
  await assert.rejects(() => empty.transcribe(Buffer.from([1]), "audio/webm"), (error: unknown) => error instanceof BatchSttError && error.code === "VOICE_NO_SPEECH");
  const timeout = new GoogleBatchSttAdapter(config, { recognize: async () => { throw { code: 4 }; } });
  await assert.rejects(() => timeout.transcribe(Buffer.from([1]), "audio/webm"), (error: unknown) => error instanceof BatchSttError && error.code === "VOICE_STT_TIMEOUT");
});
