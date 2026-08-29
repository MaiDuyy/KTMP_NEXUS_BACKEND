export interface VoiceServiceResources {
  closeLivekit: () => Promise<void> | void;
  closeRedis: () => Promise<void> | void;
}

export async function closeVoiceServiceResources(resources: VoiceServiceResources): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(resources.closeLivekit),
    Promise.resolve().then(resources.closeRedis),
  ]);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close one or more Voice Service resources");
  }
}
