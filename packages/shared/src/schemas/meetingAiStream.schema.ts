import { z } from 'zod';
import { MEETING_AI_STREAM_VERSION, type MeetingAiStreamEvent } from '../types/voice.types.js';

const base = z.object({
  version: z.literal(MEETING_AI_STREAM_VERSION),
  turnId: z.string().min(1).max(255),
});

export const meetingAiStreamEventSchema = z.discriminatedUnion('type', [
  base.extend({
    type: z.literal('speech.delta'),
    sequence: z.number().int().nonnegative(),
    text: z.string().min(1).max(20_000),
  }),
  base.extend({
    type: z.literal('display.delta'),
    sequence: z.number().int().nonnegative(),
    text: z.string().min(1).max(20_000),
  }),
  base.extend({
    type: z.literal('source'),
    sequence: z.number().int().nonnegative(),
    documentId: z.string().min(1).max(255),
    title: z.string().min(1).max(500),
    chunkId: z.string().min(1).max(255),
  }),
  base.extend({
    type: z.literal('done'),
    replayed: z.boolean(),
    usage: z.object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    }).nullable().optional(),
    latency: z.object({
      firstDeltaMs: z.number().int().nonnegative(),
      totalMs: z.number().int().nonnegative(),
    }).nullable().optional(),
  }),
]);

export function parseMeetingAiStreamEvent(value: unknown): MeetingAiStreamEvent {
  return meetingAiStreamEventSchema.parse(value) as MeetingAiStreamEvent;
}
