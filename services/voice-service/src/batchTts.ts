import { TextToSpeechClient } from "@google-cloud/text-to-speech";

export interface BatchTtsResult {
  audio: Buffer;
  contentType: string;
  encoding: string;
  sampleRateHertz: number;
  channelCount: number;
}

export interface TtsProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<BatchTtsResult>;
}

export interface GoogleBatchTtsConfig {
  projectId: string;
  location: string;
  voiceName: string;
  audioEncoding: string;
  timeoutMs: number;
}

export class BatchTtsError extends Error {
  public constructor(
    public readonly code: "VOICE_TTS_TIMEOUT" | "VOICE_TTS_UNAVAILABLE" | "VOICE_CANCELLED" | "VOICE_NO_SPEECH" | "VOICE_SPEECH_TOO_LONG"
  ) {
    super(code);
  }
}

export interface TextToSpeechSynthesizerClient {
  synthesizeSpeech(request: any, options: { timeout: number }): Promise<[any]>;
}

export class GoogleBatchTtsAdapter implements TtsProvider {
  public constructor(
    private readonly config: GoogleBatchTtsConfig,
    private readonly client: TextToSpeechSynthesizerClient = new TextToSpeechClient({
      projectId: config.projectId,
      apiEndpoint: config.location && config.location !== "global" ? `${config.location}-texttospeech.googleapis.com` : undefined
    }) as unknown as TextToSpeechSynthesizerClient,
  ) {}

  public async synthesize(text: string, signal?: AbortSignal): Promise<BatchTtsResult> {
    if (signal?.aborted) {
      throw new BatchTtsError("VOICE_CANCELLED");
    }

    const cleanText = text.trim();
    if (!cleanText) {
      throw new BatchTtsError("VOICE_NO_SPEECH");
    }
    if (cleanText.length > 5000) {
      throw new BatchTtsError("VOICE_SPEECH_TOO_LONG");
    }

    if (this.config.audioEncoding !== "LINEAR16") {
      throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
    }

    const languageCode = this.config.voiceName.split("-").slice(0, 2).join("-");

    const request = {
      input: { text: cleanText },
      voice: { name: this.config.voiceName, languageCode },
      audioConfig: { audioEncoding: this.config.audioEncoding },
    };

    try {
      const promise = this.client.synthesizeSpeech(request, { timeout: this.config.timeoutMs });

      let response: any;
      if (signal) {
        response = await new Promise((resolve, reject) => {
          let isDone = false;
          const onAbort = () => {
            if (isDone) return;
            isDone = true;
            signal.removeEventListener("abort", onAbort);
            reject(new BatchTtsError("VOICE_CANCELLED"));
          };
          if (signal.aborted) {
            return onAbort();
          }
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (res) => {
              if (isDone) return;
              isDone = true;
              signal.removeEventListener("abort", onAbort);
              resolve(res[0]);
            },
            (err) => {
              if (isDone) return;
              isDone = true;
              signal.removeEventListener("abort", onAbort);
              reject(err);
            }
          );
        });
      } else {
        const res = await promise;
        response = res[0];
      }

      if (!response || !response.audioContent) {
        throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
      }

      const audioBuffer = Buffer.from(response.audioContent);

      if (audioBuffer.length < 44 || audioBuffer.toString('utf8', 0, 4) !== 'RIFF' || audioBuffer.toString('utf8', 8, 12) !== 'WAVE') {
        throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
      }

      let contentType = "audio/wav";
      let sampleRateHertz = 0;
      let channelCount = 0;

      let offset = 12;
      let foundFmt = false;
      while (offset + 8 <= audioBuffer.length) {
        const chunkId = audioBuffer.toString('utf8', offset, offset + 4);
        const chunkSize = audioBuffer.readUInt32LE(offset + 4);
        if (chunkId === 'fmt ') {
          if (chunkSize < 16 || offset + 8 + chunkSize > audioBuffer.length) {
            break;
          }
          channelCount = audioBuffer.readUInt16LE(offset + 8 + 2);
          sampleRateHertz = audioBuffer.readUInt32LE(offset + 8 + 4);
          foundFmt = true;
          break;
        }
        offset += 8 + chunkSize;
      }

      if (!foundFmt || sampleRateHertz === 0 || channelCount === 0) {
        throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
      }

      return {
        audio: audioBuffer,
        contentType,
        encoding: this.config.audioEncoding,
        sampleRateHertz,
        channelCount,
      };
    } catch (error: any) {
      if (error instanceof BatchTtsError) {
        throw error;
      }
      if (error?.code === 4 || error?.code === "DEADLINE_EXCEEDED") {
        throw new BatchTtsError("VOICE_TTS_TIMEOUT");
      }
      if (error?.code === 1 || error?.code === "CANCELLED") {
        throw new BatchTtsError("VOICE_CANCELLED");
      }
      throw new BatchTtsError("VOICE_TTS_UNAVAILABLE");
    }
  }
}
