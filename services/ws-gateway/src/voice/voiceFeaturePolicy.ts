export interface VoiceFeaturePolicy {
  enabled: boolean;
  allowedWorkspaceIds: ReadonlySet<string>;
  isWorkspaceAllowed(workspaceId: string): boolean;
}

function readBoolean(value: string | undefined, fallback: boolean, variableName: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${variableName} must be true, false, 1, or 0`);
}

function readWorkspaceIds(value: string | undefined): ReadonlySet<string> {
  if (!value?.trim()) return new Set();
  const values = value.split(',').map((entry) => entry.trim());
  if (values.some((entry) => entry.length === 0 || entry.length > 256)) {
    throw new Error('MEETING_VOICE_ALLOWED_WORKSPACE_IDS contains an invalid workspace ID');
  }
  return new Set(values);
}

export function loadVoiceFeaturePolicy(env: NodeJS.ProcessEnv = process.env): VoiceFeaturePolicy {
  const production = env.NODE_ENV === 'production';
  const enabled = readBoolean(env.MEETING_VOICE_ENABLED, !production, 'MEETING_VOICE_ENABLED');
  const allowedWorkspaceIds = readWorkspaceIds(env.MEETING_VOICE_ALLOWED_WORKSPACE_IDS);

  return {
    enabled,
    allowedWorkspaceIds,
    isWorkspaceAllowed: (workspaceId) => enabled && (
      allowedWorkspaceIds.size === 0 || allowedWorkspaceIds.has(workspaceId)
    ),
  };
}

export function readVoiceMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolean(env.VOICE_METRICS_ENABLED, env.NODE_ENV !== 'production', 'VOICE_METRICS_ENABLED');
}
