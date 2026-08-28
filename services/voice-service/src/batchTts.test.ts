import test from "node:test";
import assert from "node:assert";
import { GoogleBatchTtsAdapter, BatchTtsError, type TextToSpeechSynthesizerClient, type GoogleBatchTtsConfig } from "./batchTts.js";

test("GoogleBatchTtsAdapter", async (t) => {
  const config: GoogleBatchTtsConfig = {
    projectId: "test-project",
    location: "asia-southeast1",
    voiceName: "vi-VN-Chirp3-HD-Charon",
    audioEncoding: "LINEAR16",
    timeoutMs: 5000,
  };

  const createMockClient = (behavior: (req: any, opts: any) => Promise<[any]>): TextToSpeechSynthesizerClient => ({
    synthesizeSpeech: async (request: any, options: any) => behavior(request, options),
  });

  const createWavBuffer = (opts: { badRiff?: boolean, badWave?: boolean, noFmt?: boolean, extraChunk?: boolean, shortBuffer?: boolean, badMeta?: boolean }) => {
    if (opts.shortBuffer) return Buffer.alloc(10);
    const chunks = [];
    if (opts.extraChunk) {
      const extra = Buffer.alloc(12);
      extra.write("JUNK", 0);
      extra.writeUInt32LE(4, 4);
      extra.writeUInt32LE(0, 8);
      chunks.push(extra);
    }
    if (!opts.noFmt) {
      const fmt = Buffer.alloc(24);
      fmt.write("fmt ", 0);
      fmt.writeUInt32LE(16, 4);
      fmt.writeUInt16LE(1, 8); // format
      fmt.writeUInt16LE(opts.badMeta ? 0 : 1, 10); // channels
      fmt.writeUInt32LE(opts.badMeta ? 0 : 24000, 12); // sample rate
      fmt.writeUInt32LE(48000, 16); // byte rate
      fmt.writeUInt16LE(2, 20); // block align
      fmt.writeUInt16LE(16, 22); // bits per sample
      chunks.push(fmt);
    }
    const data = Buffer.alloc(12);
    data.write("data", 0);
    data.writeUInt32LE(4, 4);
    data.writeUInt32LE(0, 8);
    chunks.push(data);

    const totalSize = chunks.reduce((acc, c) => acc + c.length, 0) + 4;
    const header = Buffer.alloc(12);
    header.write(opts.badRiff ? "RxFF" : "RIFF", 0);
    header.writeUInt32LE(totalSize, 4);
    header.write(opts.badWave ? "WXXE" : "WAVE", 8);

    return Buffer.concat([header, ...chunks]);
  };

  await t.test("should return audio and metadata on success (valid fmt chunk)", async () => {
    const mockAudio = createWavBuffer({});
    const client = createMockClient(async (req) => {
      assert.strictEqual(req.input.text, "Xin chào");
      return [{ audioContent: mockAudio }];
    });
    const adapter = new GoogleBatchTtsAdapter(config, client);
    const result = await adapter.synthesize(" Xin chào  ");

    assert.strictEqual(result.audio.toString("base64"), mockAudio.toString("base64"));
    assert.strictEqual(result.contentType, "audio/wav");
    assert.strictEqual(result.encoding, "LINEAR16");
    assert.strictEqual(result.sampleRateHertz, 24000);
    assert.strictEqual(result.channelCount, 1);
  });

  await t.test("should parse WAV correctly when there is an extra chunk before fmt", async () => {
    const mockAudio = createWavBuffer({ extraChunk: true });
    const client = createMockClient(async () => [{ audioContent: mockAudio }]);
    const adapter = new GoogleBatchTtsAdapter(config, client);
    const result = await adapter.synthesize("test");
    assert.strictEqual(result.sampleRateHertz, 24000);
    assert.strictEqual(result.channelCount, 1);
  });

  await t.test("should map empty text to VOICE_NO_SPEECH", async () => {
    const client = createMockClient(async () => { throw new Error("Should not be called"); });
    const adapter = new GoogleBatchTtsAdapter(config, client);
    await assert.rejects(adapter.synthesize("   \n "), (err: any) => err instanceof BatchTtsError && err.code === "VOICE_NO_SPEECH");
  });

  await t.test("should map too long text to VOICE_SPEECH_TOO_LONG", async () => {
    const client = createMockClient(async () => { throw new Error("Should not be called"); });
    const adapter = new GoogleBatchTtsAdapter(config, client);
    const longText = "a".repeat(5001);
    await assert.rejects(adapter.synthesize(longText), (err: any) => err instanceof BatchTtsError && err.code === "VOICE_SPEECH_TOO_LONG");
  });

  await t.test("should map DEADLINE_EXCEEDED to VOICE_TTS_TIMEOUT", async () => {
    const client = createMockClient(async () => {
      const err = new Error("Deadline Exceeded");
      (err as any).code = 4;
      throw err;
    });
    const adapter = new GoogleBatchTtsAdapter(config, client);
    await assert.rejects(adapter.synthesize("test"), (err: any) => err instanceof BatchTtsError && err.code === "VOICE_TTS_TIMEOUT");
  });

  await t.test("should map internal provider error to VOICE_TTS_UNAVAILABLE", async () => {
    const client = createMockClient(async () => { throw new Error("Internal Server Error"); });
    const adapter = new GoogleBatchTtsAdapter(config, client);
    await assert.rejects(adapter.synthesize("test"), (err: any) => err instanceof BatchTtsError && err.code === "VOICE_TTS_UNAVAILABLE");
  });

  await t.test("should map empty audio to VOICE_TTS_UNAVAILABLE", async () => {
    const client = createMockClient(async () => [{ audioContent: null }]);
    const adapter = new GoogleBatchTtsAdapter(config, client);
    await assert.rejects(adapter.synthesize("test"), (err: any) => err instanceof BatchTtsError && err.code === "VOICE_TTS_UNAVAILABLE");
  });

  await t.test("should reject unsupported encoding", async () => {
    const client = createMockClient(async () => [{ audioContent: Buffer.alloc(0) }]);
    const adapter = new GoogleBatchTtsAdapter({ ...config, audioEncoding: "MP3" }, client);
    await assert.rejects(adapter.synthesize("test"), (err: any) => err instanceof BatchTtsError && err.code === "VOICE_TTS_UNAVAILABLE");
  });

  await t.test("should reject short buffer, bad RIFF, bad WAVE, missing fmt, metadata 0", async () => {
    const client = createMockClient(async () => [{ audioContent: Buffer.alloc(0) }]);
    const adapter = new GoogleBatchTtsAdapter(config, client);

    client.synthesizeSpeech = async () => [{ audioContent: createWavBuffer({ shortBuffer: true }) }];
    await assert.rejects(adapter.synthesize("test"), (err: any) => err.code === "VOICE_TTS_UNAVAILABLE", "shortBuffer");

    client.synthesizeSpeech = async () => [{ audioContent: createWavBuffer({ badRiff: true }) }];
    await assert.rejects(adapter.synthesize("test"), (err: any) => err.code === "VOICE_TTS_UNAVAILABLE", "badRiff");

    client.synthesizeSpeech = async () => [{ audioContent: createWavBuffer({ badWave: true }) }];
    await assert.rejects(adapter.synthesize("test"), (err: any) => err.code === "VOICE_TTS_UNAVAILABLE", "badWave");

    client.synthesizeSpeech = async () => [{ audioContent: createWavBuffer({ noFmt: true }) }];
    await assert.rejects(adapter.synthesize("test"), (err: any) => err.code === "VOICE_TTS_UNAVAILABLE", "noFmt");

    client.synthesizeSpeech = async () => [{ audioContent: createWavBuffer({ badMeta: true }) }];
    await assert.rejects(adapter.synthesize("test"), (err: any) => err.code === "VOICE_TTS_UNAVAILABLE", "badMeta");
  });

  await t.test("should support AbortSignal to cancel early", async () => {
    const client = createMockClient(async () => { throw new Error("Should not be called"); });
    const adapter = new GoogleBatchTtsAdapter(config, client);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(adapter.synthesize("test", controller.signal), (err: any) => err instanceof BatchTtsError && err.code === "VOICE_CANCELLED");
  });

  await t.test("should cleanup listener when abort wins race", async () => {
    let internalPromiseResolve: any;
    const client = createMockClient(async () => {
      return new Promise((resolve) => { internalPromiseResolve = resolve; });
    });
    const adapter = new GoogleBatchTtsAdapter(config, client);
    const controller = new AbortController();

    // Check listener count before
    class TestSignal extends EventTarget {
      aborted = false;
      added = 0;
      removed = 0;
      addEventListener(type: string, listener: any, options?: any) {
        if (type === "abort") this.added++;
        super.addEventListener(type, listener, options);
      }
      removeEventListener(type: string, listener: any) {
        if (type === "abort") this.removed++;
        super.removeEventListener(type, listener);
      }
      abort() {
        this.aborted = true;
        this.dispatchEvent(new Event("abort"));
      }
    }
    const signal = new TestSignal();

    const promise = adapter.synthesize("test", signal as any);
    signal.abort();

    await assert.rejects(promise, (err: any) => err instanceof BatchTtsError && err.code === "VOICE_CANCELLED");

    // Simulate provider resolving after abort
    internalPromiseResolve([{ audioContent: createWavBuffer({}) }]);

    // Allow macro task queue to settle
    await new Promise(r => setTimeout(r, 0));

    assert.strictEqual(signal.added, 1);
    assert.strictEqual(signal.removed, 1);
  });

  await t.test("should cleanup listener when provider resolve wins race", async () => {
    const client = createMockClient(async () => [{ audioContent: createWavBuffer({}) }]);
    const adapter = new GoogleBatchTtsAdapter(config, client);
    const controller = new AbortController();

    class TestSignal extends EventTarget {
      aborted = false;
      added = 0;
      removed = 0;
      addEventListener(type: string, listener: any, options?: any) {
        if (type === "abort") this.added++;
        super.addEventListener(type, listener, options);
      }
      removeEventListener(type: string, listener: any) {
        if (type === "abort") this.removed++;
        super.removeEventListener(type, listener);
      }
    }
    const signal = new TestSignal();

    await adapter.synthesize("test", signal as any);
    assert.strictEqual(signal.added, 1);
    assert.strictEqual(signal.removed, 1);
  });

  await t.test("should cleanup listener when provider reject wins race", async () => {
    const client = createMockClient(async () => { throw new Error("Internal provider error"); });
    const adapter = new GoogleBatchTtsAdapter(config, client);

    class TestSignal extends EventTarget {
      aborted = false;
      added = 0;
      removed = 0;
      addEventListener(type: string, listener: any, options?: any) {
        if (type === "abort") this.added++;
        super.addEventListener(type, listener, options);
      }
      removeEventListener(type: string, listener: any) {
        if (type === "abort") this.removed++;
        super.removeEventListener(type, listener);
      }
    }
    const signal = new TestSignal();

    await assert.rejects(adapter.synthesize("test", signal as any));
    assert.strictEqual(signal.added, 1);
    assert.strictEqual(signal.removed, 1);
  });
});
