export class VoiceMeetingCleanupError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class VoiceMeetingCleanupClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: string,
    private readonly timeoutMs: number = 15_000,
    private readonly maxAttempts: number = 2,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 3) {
      throw new Error('maxAttempts must be from 1 to 3');
    }
  }

  public async cleanupMeeting(meetingSessionId: string, cleanupId: string): Promise<void> {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/meetings/${encodeURIComponent(meetingSessionId)}/cleanup`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'x-voice-internal-service-key': this.serviceKey,
            'x-voice-cleanup-id': cleanupId,
          },
          signal: controller.signal,
        });
        if (response.ok) return;
        lastError = new Error(`voice cleanup returned ${response.status}`);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new VoiceMeetingCleanupError(lastError instanceof Error ? lastError.message : 'voice cleanup failed');
  }
}
