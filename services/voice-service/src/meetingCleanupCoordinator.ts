import type { BatchVoiceOrchestrator } from './batchVoiceOrchestrator.js';
import type { MeetingAiClient } from './internalClients.js';
import type { MeetingAudioPublisher } from './livekit/MeetingAudioPublisher.js';
import type { StreamingMeetingAudioPublisher } from './livekit/StreamingMeetingAudioPublisher.js';
import type { VoiceServiceLogger } from './logger.js';
import type { VoiceCleanupResource } from './voiceMetrics.js';

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
    metrics?: { recordLifecycleCleanup(resource: VoiceCleanupResource, outcome: 'completed' | 'failed'): void };
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
    const cleanup = async (resource: VoiceCleanupResource, operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
        this.dependencies.metrics?.recordLifecycleCleanup(resource, 'completed');
      } catch {
        failures.push(resource);
        this.dependencies.metrics?.recordLifecycleCleanup(resource, 'failed');
      }
    };
    try {
      await cleanup('ai_ending', () => this.dependencies.meetingAi.beginMeetingCleanup(meetingSessionId, controller.signal));
      if (this.dependencies.streaming) {
        await cleanup('stream_input', () => this.dependencies.streaming!.cancelMeeting(meetingSessionId));
      }
      if (this.dependencies.orchestrator) {
        await cleanup('pipeline', () => this.dependencies.orchestrator!.cancelMeeting(meetingSessionId));
      }
      await cleanup('batch_livekit', () => this.dependencies.publisher.closeMeeting(meetingSessionId));
      if (this.dependencies.streamingPublisher) {
        await cleanup('streaming_livekit', () => this.dependencies.streamingPublisher!.closeMeeting(meetingSessionId));
      }
      await cleanup('ai_cleanup', () => this.dependencies.meetingAi.completeMeetingCleanup(meetingSessionId, controller.signal));
      if (failures.length > 0) throw new MeetingCleanupError(failures.join(','));
      this.dependencies.logger.info({ meetingSessionId, cleanupId }, 'Voice meeting cleanup completed');
    } finally {
      clearTimeout(timer);
    }
  }
}
