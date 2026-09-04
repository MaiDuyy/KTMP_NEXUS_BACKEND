import type {
  MeetingAiStreamEvent,
  VoicePipelineContextRequest,
  VoicePipelineContextResponse,
  VoicePipelineEvent,
} from '@ott/shared';
import { parseMeetingAiStreamEvent } from '@ott/shared';

export class InternalServiceError extends Error {
  public constructor(
    public readonly code: 'VOICE_CANCELLED' | 'VOICE_AI_TIMEOUT' | 'VOICE_AI_UNAVAILABLE' | 'VOICE_AI_QUOTA_EXCEEDED' | 'VOICE_INTERNAL_ERROR',
  ) {
    super(code);
  }
}

export interface MeetingAiRequest {
  meetingSessionId: string;
  chatId: string;
  workspaceId: string;
  turnId: string;
  speakerUserId: string;
  speakerName: string;
  participantIds: string[];
  message: string;
}

export interface MeetingAiResponse {
  conversationId: number;
  meetingSessionId: string;
  turnId: string;
  displayText: string;
  speechText: string;
  replayed: boolean;
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

class SseEventDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private eventName = '';
  private readonly dataLines: string[] = [];

  public push(chunk: Uint8Array): ParsedSseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.consumeLines(false);
  }

  public finish(): ParsedSseEvent[] {
    this.buffer += this.decoder.decode();
    return this.consumeLines(true);
  }

  private consumeLines(final: boolean): ParsedSseEvent[] {
    const events: ParsedSseEvent[] = [];
    while (true) {
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd < 0) break;
      const line = this.buffer.slice(0, lineEnd).replace(/\r$/, '');
      this.buffer = this.buffer.slice(lineEnd + 1);
      this.consumeLine(line, events);
    }
    if (final && this.buffer.length > 0) {
      this.consumeLine(this.buffer.replace(/\r$/, ''), events);
      this.buffer = '';
    }
    if (final) this.dispatch(events);
    return events;
  }

  private consumeLine(line: string, events: ParsedSseEvent[]): void {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') this.eventName = value;
    if (field === 'data') this.dataLines.push(value);
  }

  private dispatch(events: ParsedSseEvent[]): void {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return;
    }
    events.push({ event: this.eventName || 'message', data: this.dataLines.join('\n') });
    this.eventName = '';
    this.dataLines.length = 0;
  }
}

async function requestJson<T>(options: {
  url: string;
  serviceKeyHeader: string;
  serviceKey: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutCode: InternalServiceError['code'];
  unavailableCode: InternalServiceError['code'];
  quotaCode?: InternalServiceError['code'];
}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), options.timeoutMs);
  const onAbort = () => controller.abort('cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [options.serviceKeyHeader]: options.serviceKey,
      },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (response.status === 429 && options.quotaCode) {
      throw new InternalServiceError(options.quotaCode);
    }
    if (response.status === 409) {
      throw new InternalServiceError('VOICE_CANCELLED');
    }
    if (!response.ok) {
      throw new InternalServiceError(options.unavailableCode);
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof InternalServiceError) throw error;
    if (options.signal?.aborted || controller.signal.reason === 'cancelled') {
      throw new InternalServiceError('VOICE_CANCELLED');
    }
    if (controller.signal.aborted) {
      throw new InternalServiceError(options.timeoutCode);
    }
    throw new InternalServiceError(options.unavailableCode);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export class VoiceControlClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: string,
    private readonly timeoutMs: number = 10_000,
  ) {}

  private endpoint(path: string): string {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
    return url.toString();
  }

  public getContext(
    request: VoicePipelineContextRequest,
    signal?: AbortSignal,
  ): Promise<VoicePipelineContextResponse> {
    return requestJson({
      url: this.endpoint('turns/context'),
      serviceKeyHeader: 'x-voice-internal-service-key',
      serviceKey: this.serviceKey,
      body: request,
      timeoutMs: this.timeoutMs,
      signal,
      timeoutCode: 'VOICE_INTERNAL_ERROR',
      unavailableCode: 'VOICE_INTERNAL_ERROR',
    });
  }

  public async emit(event: VoicePipelineEvent, signal?: AbortSignal): Promise<void> {
    await requestJson({
      url: this.endpoint('turns/events'),
      serviceKeyHeader: 'x-voice-internal-service-key',
      serviceKey: this.serviceKey,
      body: event,
      timeoutMs: this.timeoutMs,
      signal,
      timeoutCode: 'VOICE_INTERNAL_ERROR',
      unavailableCode: 'VOICE_INTERNAL_ERROR',
    });
  }
}

import {
  CircuitBreaker,
  CircuitPermit,
  ProviderResilienceConfig,
  Resilience,
  getResilienceObserver,
} from './resilience.js';

export class MeetingAiClient {
  public readonly bufferedCircuitBreaker: CircuitBreaker;
  public readonly streamingCircuitBreaker: CircuitBreaker;

  public constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly timeoutMs: number,
    private readonly firstEventTimeoutMs: number = 10_000,
    private readonly idleEventTimeoutMs: number = 20_000,
    resilienceConfig?: ProviderResilienceConfig,
  ) {
    this.bufferedCircuitBreaker = new CircuitBreaker('meeting_ai/buffered', {
      failureThreshold: resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
    this.streamingCircuitBreaker = new CircuitBreaker('meeting_ai/streaming', {
      failureThreshold: resilienceConfig?.circuitBreakerFailureThreshold ?? 3,
      openDurationMs: resilienceConfig?.circuitBreakerOpenDurationMs ?? 15_000,
      halfOpenProbeLimit: resilienceConfig?.circuitBreakerHalfOpenProbeLimit ?? 1,
      failureWindowMs: resilienceConfig?.circuitBreakerFailureWindowMs ?? 60_000,
    });
  }

  public async answer(request: MeetingAiRequest, signal?: AbortSignal): Promise<MeetingAiResponse> {
    return Resilience.execute({
      operation: async () => {
        return requestJson({
          url: this.url,
          serviceKeyHeader: 'x-meeting-ai-service-key',
          serviceKey: this.serviceKey,
          body: request,
          timeoutMs: this.timeoutMs,
          signal,
          timeoutCode: 'VOICE_AI_TIMEOUT',
          unavailableCode: 'VOICE_AI_UNAVAILABLE',
          quotaCode: 'VOICE_AI_QUOTA_EXCEEDED',
        });
      },
      operationName: 'meeting_ai/buffered',
      circuitBreaker: this.bufferedCircuitBreaker,
      retry: {
        maxAttempts: 1, // Do not retry after dispatch per policy
        baseBackoffMs: 200,
        maxBackoffMs: 2000,
      },
      signal,
      isTransientError: (err: any) => err instanceof InternalServiceError && (err.code === 'VOICE_AI_TIMEOUT' || err.code === 'VOICE_AI_UNAVAILABLE'),
      mapError: (err: any, circuitOpen: boolean) => {
        if (circuitOpen) return new InternalServiceError('VOICE_AI_UNAVAILABLE');
        if (err instanceof InternalServiceError) return err;
        return new InternalServiceError('VOICE_AI_UNAVAILABLE');
      }
    });
  }

  public async *stream(request: MeetingAiRequest, signal?: AbortSignal): AsyncGenerator<MeetingAiStreamEvent> {
    if (signal?.aborted) throw new InternalServiceError('VOICE_CANCELLED');

    let permit: CircuitPermit;
    try {
      permit = this.streamingCircuitBreaker.acquire();
    } catch (err) {
      throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort('cancelled');
    const totalTimer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    let eventTimer: ReturnType<typeof setTimeout> | null = null;
    let hasReceivedEvent = false;

    const armEventTimer = (): void => {
      if (eventTimer) clearTimeout(eventTimer);
      const delay = hasReceivedEvent ? this.idleEventTimeoutMs : this.firstEventTimeoutMs;
      eventTimer = setTimeout(() => controller.abort(hasReceivedEvent ? 'idle-timeout' : 'first-event-timeout'), delay);
    };

    const clearTimers = (): void => {
      clearTimeout(totalTimer);
      if (eventTimer) clearTimeout(eventTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    try {
      signal?.addEventListener('abort', onAbort, { once: true });
      armEventTimer();

      const streamUrl = new URL(this.url);
      streamUrl.pathname = `${streamUrl.pathname.replace(/\/$/, '')}/stream`;
      const response = await fetch(streamUrl, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          'x-meeting-ai-service-key': this.serviceKey,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new InternalServiceError('VOICE_AI_QUOTA_EXCEEDED');
      }
      if (response.status === 409) {
        throw new InternalServiceError('VOICE_CANCELLED');
      }
      if (!response.ok || !response.body) {
        throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('text/event-stream')) {
        throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
      }

      const decoder = new SseEventDecoder();
      const expectedSequences = new Map<string, number>([
        ['speech.delta', 0],
        ['display.delta', 0],
        ['source', 0],
      ]);
      const sourceIdentity = new Set<string>();
      let done = false;
      const reader = response.body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          for (const raw of decoder.push(next.value)) {
            const event = this.validateStreamEvent(raw, request.turnId, expectedSequences, sourceIdentity, done);
            if (!event) continue;
            hasReceivedEvent = true;
            armEventTimer();
            if (event.type === 'done') done = true;
            yield event;
          }
        }
        for (const raw of decoder.finish()) {
          const event = this.validateStreamEvent(raw, request.turnId, expectedSequences, sourceIdentity, done);
          if (!event) continue;
          hasReceivedEvent = true;
          if (event.type === 'done') done = true;
          yield event;
        }
      } finally {
        reader.releaseLock();
      }
      if (!done) throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
      permit.recordSuccess();
      return;
    } catch (error) {
      let mappedError = error;
      if (!(error instanceof InternalServiceError)) {
        if (signal?.aborted || controller.signal.reason === 'cancelled') {
          mappedError = new InternalServiceError('VOICE_CANCELLED');
        } else if (controller.signal.aborted) {
          mappedError = new InternalServiceError('VOICE_AI_TIMEOUT');
        } else {
          mappedError = new InternalServiceError('VOICE_AI_UNAVAILABLE');
        }
      }

      const err = mappedError as InternalServiceError;
      const isTransient = err.code === 'VOICE_AI_TIMEOUT' || err.code === 'VOICE_AI_UNAVAILABLE';

      if (err.code === 'VOICE_AI_QUOTA_EXCEEDED') {
        getResilienceObserver()?.recordQuotaRejection('meeting_ai');
        permit.release();
      } else if (isTransient) {
        permit.recordFailure();
      } else {
        permit.release();
      }

      throw err;
    } finally {
      clearTimers();
      permit.release();
    }
  }

  private validateStreamEvent(
    raw: ParsedSseEvent,
    turnId: string,
    expectedSequences: Map<string, number>,
    sourceIdentity: Set<string>,
    done: boolean,
  ): MeetingAiStreamEvent | null {
    let parsed: MeetingAiStreamEvent;
    try {
      parsed = parseMeetingAiStreamEvent(JSON.parse(raw.data));
    } catch {
      throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
    }
    if (parsed.type !== raw.event || parsed.turnId !== turnId || done) {
      throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
    }
    if (parsed.type === 'done') return parsed;

    const expected = expectedSequences.get(parsed.type);
    if (expected === undefined || parsed.sequence !== expected) {
      throw new InternalServiceError('VOICE_AI_UNAVAILABLE');
    }
    expectedSequences.set(parsed.type, expected + 1);
    if (parsed.type === 'source') {
      const identity = `${parsed.documentId}:${parsed.chunkId}`;
      if (sourceIdentity.has(identity)) {
        return null;
      }
      sourceIdentity.add(identity);
    }
    return parsed;
  }

  private meetingLifecycleUrl(meetingSessionId: string, action: 'ending' | 'cleanup'): string {
    const url = new URL(this.url);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/meetings/${encodeURIComponent(meetingSessionId)}/${action}`;
    return url.toString();
  }

  public async beginMeetingCleanup(meetingSessionId: string, signal?: AbortSignal): Promise<void> {
    await requestJson({
      url: this.meetingLifecycleUrl(meetingSessionId, 'ending'),
      serviceKeyHeader: 'x-meeting-ai-service-key',
      serviceKey: this.serviceKey,
      body: {},
      timeoutMs: this.timeoutMs,
      signal,
      timeoutCode: 'VOICE_AI_TIMEOUT',
      unavailableCode: 'VOICE_AI_UNAVAILABLE',
    });
  }

  public async completeMeetingCleanup(meetingSessionId: string, signal?: AbortSignal): Promise<void> {
    await requestJson({
      url: this.meetingLifecycleUrl(meetingSessionId, 'cleanup'),
      serviceKeyHeader: 'x-meeting-ai-service-key',
      serviceKey: this.serviceKey,
      body: {},
      timeoutMs: this.timeoutMs,
      signal,
      timeoutCode: 'VOICE_AI_TIMEOUT',
      unavailableCode: 'VOICE_AI_UNAVAILABLE',
    });
  }
}
