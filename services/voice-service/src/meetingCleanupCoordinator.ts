import type { BatchVoiceOrchestrator } from './batchVoiceOrchestrator.js';
import type { MeetingAiClient } from './internalClients.js';
import type { MeetingAudioPublisher } from './livekit/MeetingAudioPublisher.js';
import type { StreamingMeetingAudioPublisher } from './livekit/StreamingMeetingAudioPublisher.js';
import type { VoiceServiceLogger } from './logger.js';

export class MeetingCleanupError extends Error {}

export class MeetingCleanupCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(private readonly dependencies: {
    orchestrator: Pick<BatchVoiceOrchestrator, 'cancelMeeting'> | null;
    streaming?: { cancelMeeting(meetingSessionId: string): Promise<void> } | null;
    publisher: MeetingAudioPublisher;
    streamingPublisher?: Pick<StreamingMeetingAudioPublisher, 'closeMeeting'> | null;
    meetingAi: MeetingAiClient;
    logger: VoiceServiceLogger;
    timeoutMs: number;
  }) {}

  public cleanup(meetingSessionId: string, cleanupId: string): Promise<void> {
    const existing = this.inFlight.get(meetingSessionId);
    if (existing) return existing;
    const operation = this.run(meetingSessionId, cleanupId)
      .finally(() => this.inFlight.delete(meetingSessionId));
    this.inFlight.set(meetingSessionId, operation);
    return operation;
  }

  private async run(meetingSessionId: string, cleanupId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('cleanup-timeout'), this.dependencies.timeoutMs);
    const failures: string[] = [];
    try {
      await this.dependencies.meetingAi.beginMeetingCleanup(meetingSessionId, controller.signal)
        .catch(() => failures.push('ai-ending'));
      if (this.dependencies.streaming) {
        await this.dependencies.streaming.cancelMeeting(meetingSessionId)
          .catch(() => failures.push('stream-cancel'));
      }
      if (this.dependencies.orchestrator) {
        await this.dependencies.orchestrator.cancelMeeting(meetingSessionId)
          .catch(() => failures.push('pipeline-cancel'));
      }
      await this.dependencies.publisher.closeMeeting(meetingSessionId)
        .catch(() => failures.push('livekit-close'));
      if (this.dependencies.streamingPublisher) {
        await this.dependencies.streamingPublisher.closeMeeting(meetingSessionId)
          .catch(() => failures.push('streaming-livekit-close'));
      }
      await this.dependencies.meetingAi.completeMeetingCleanup(meetingSessionId, controller.signal)
        .catch(() => failures.push('ai-cleanup'));
      if (failures.length > 0) throw new MeetingCleanupError(failures.join(','));
      this.dependencies.logger.info({ meetingSessionId, cleanupId }, 'Voice meeting cleanup completed');
    } finally {
      clearTimeout(timer);
    }
  }
}
