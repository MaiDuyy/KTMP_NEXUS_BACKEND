import type {
  VoicePipelineContextRequest,
  VoicePipelineContextResponse,
  VoicePipelineEvent,
} from '@ott/shared';

export class InternalServiceError extends Error {
  public constructor(
    public readonly code: 'VOICE_CANCELLED' | 'VOICE_AI_TIMEOUT' | 'VOICE_AI_UNAVAILABLE' | 'VOICE_INTERNAL_ERROR',
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

async function requestJson<T>(options: {
  url: string;
  serviceKeyHeader: string;
  serviceKey: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutCode: InternalServiceError['code'];
  unavailableCode: InternalServiceError['code'];
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

export class MeetingAiClient {
  public constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly timeoutMs: number,
  ) {}

  public answer(request: MeetingAiRequest, signal?: AbortSignal): Promise<MeetingAiResponse> {
    return requestJson({
      url: this.url,
      serviceKeyHeader: 'x-meeting-ai-service-key',
      serviceKey: this.serviceKey,
      body: request,
      timeoutMs: this.timeoutMs,
      signal,
      timeoutCode: 'VOICE_AI_TIMEOUT',
      unavailableCode: 'VOICE_AI_UNAVAILABLE',
    });
  }
}
