import type { VoicePipelineContextResponse } from '@ott/shared';

const MAX_PHRASES = 100;
const MAX_PHRASE_BYTES = 100;
const MAX_TOTAL_BYTES = 5_000;

export function normalizeSpeechPhrases(values: readonly string[]): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const value of values) {
    const phrase = value.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!phrase) continue;
    const bytes = Buffer.byteLength(phrase, 'utf8');
    const key = phrase.toLocaleLowerCase('vi-VN');
    if (bytes > MAX_PHRASE_BYTES || seen.has(key)) continue;
    if (phrases.length >= MAX_PHRASES || totalBytes + bytes > MAX_TOTAL_BYTES) break;
    phrases.push(phrase);
    seen.add(key);
    totalBytes += bytes;
  }
  return phrases;
}

export interface WorkspaceSpeechPhraseSource {
  load(context: VoicePipelineContextResponse): Promise<readonly string[]>;
}

export interface SpeechAdaptationProvider {
  getPhrases(context: VoicePipelineContextResponse): Promise<readonly string[]>;
}

interface CacheEntry {
  expiresAt: number;
  phrases: readonly string[];
}

export class CachedSpeechAdaptationProvider implements SpeechAdaptationProvider {
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(
    private readonly source: WorkspaceSpeechPhraseSource,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  public async getPhrases(context: VoicePipelineContextResponse): Promise<readonly string[]> {
    const cached = this.cache.get(context.workspaceId);
    let workspacePhrases: readonly string[] = cached?.phrases ?? [];
    if (!cached || cached.expiresAt <= this.now()) {
      workspacePhrases = [];
      try {
        workspacePhrases = normalizeSpeechPhrases(await this.source.load(context));
        this.cache.set(context.workspaceId, { phrases: workspacePhrases, expiresAt: this.now() + this.ttlMs });
      } catch {
        // Adaptation is optional; an unavailable source must not fail the voice turn.
      }
    }
    return normalizeSpeechPhrases([context.ownerName, ...workspacePhrases]);
  }
}

export class ConfiguredSpeechPhraseSource implements WorkspaceSpeechPhraseSource {
  public constructor(private readonly phrases: readonly string[]) {}

  public async load(): Promise<readonly string[]> {
    return this.phrases;
  }
}
