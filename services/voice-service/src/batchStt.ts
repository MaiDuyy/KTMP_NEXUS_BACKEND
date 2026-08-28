import { SpeechClient } from "@google-cloud/speech";

export interface BatchSttConfig { projectId: string; location: string; model: string; languageCode: string; timeoutMs: number; }
export interface BatchSttResult { transcript: string; confidence: number | null; }
export interface SpeechRecognizerClient { recognize(request: unknown, options: { timeout: number }): Promise<[any]>; }

export class BatchSttError extends Error { public constructor(public readonly code: "VOICE_NO_SPEECH" | "VOICE_STT_TIMEOUT" | "VOICE_STT_UNAVAILABLE") { super(code); } }

export class GoogleBatchSttAdapter {
  public constructor(private readonly config: BatchSttConfig, private readonly client: SpeechRecognizerClient = new SpeechClient() as unknown as SpeechRecognizerClient) {}
  public async transcribe(audio: Buffer, mimeType: string): Promise<BatchSttResult> {
    try {
      const [response] = await this.client.recognize({
        recognizer: `projects/${this.config.projectId}/locations/${this.config.location}/recognizers/_`,
        config: { autoDecodingConfig: {}, languageCodes: [this.config.languageCode], model: this.config.model },
        content: audio.toString("base64"),
      }, { timeout: this.config.timeoutMs });
      const alternatives = response.results?.flatMap((result: any) => result.alternatives ?? []) ?? [];
      const transcript = alternatives.map((alternative: any) => alternative.transcript ?? "").join(" ").trim();
      if (!transcript) throw new BatchSttError("VOICE_NO_SPEECH");
      const confidence = alternatives.find((alternative: any) => typeof alternative.confidence === "number")?.confidence ?? null;
      return { transcript, confidence };
    } catch (error: any) {
      if (error instanceof BatchSttError) throw error;
      if (error?.code === 4 || error?.code === "DEADLINE_EXCEEDED") throw new BatchSttError("VOICE_STT_TIMEOUT");
      throw new BatchSttError("VOICE_STT_UNAVAILABLE");
    }
  }
}
