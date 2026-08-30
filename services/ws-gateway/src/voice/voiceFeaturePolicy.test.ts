import assert from 'node:assert/strict';
import test from 'node:test';
import { loadVoiceFeaturePolicy, readVoiceMetricsEnabled } from './voiceFeaturePolicy.js';

test('voice feature defaults on outside production and off in production', () => {
  assert.equal(loadVoiceFeaturePolicy({ NODE_ENV: 'test' }).enabled, true);
  assert.equal(loadVoiceFeaturePolicy({ NODE_ENV: 'production' }).enabled, false);
  assert.equal(readVoiceMetricsEnabled({ NODE_ENV: 'test' }), true);
  assert.equal(readVoiceMetricsEnabled({ NODE_ENV: 'production' }), false);
});

test('voice feature parses strict booleans and fails fast on invalid values', () => {
  assert.equal(loadVoiceFeaturePolicy({ MEETING_VOICE_ENABLED: '1' }).enabled, true);
  assert.equal(loadVoiceFeaturePolicy({ MEETING_VOICE_ENABLED: 'false' }).enabled, false);
  assert.throws(
    () => loadVoiceFeaturePolicy({ MEETING_VOICE_ENABLED: 'yes' }),
    /MEETING_VOICE_ENABLED must be true, false, 1, or 0/,
  );
  assert.throws(
    () => readVoiceMetricsEnabled({ VOICE_METRICS_ENABLED: 'enabled' }),
    /VOICE_METRICS_ENABLED must be true, false, 1, or 0/,
  );
});

test('voice feature trims and deduplicates the optional workspace allowlist', () => {
  const policy = loadVoiceFeaturePolicy({
    MEETING_VOICE_ENABLED: 'true',
    MEETING_VOICE_ALLOWED_WORKSPACE_IDS: ' workspace-1,workspace-2,workspace-1 ',
  });
  assert.deepEqual([...policy.allowedWorkspaceIds], ['workspace-1', 'workspace-2']);
  assert.equal(policy.isWorkspaceAllowed('workspace-1'), true);
  assert.equal(policy.isWorkspaceAllowed('workspace-3'), false);

  const unrestricted = loadVoiceFeaturePolicy({ MEETING_VOICE_ENABLED: 'true' });
  assert.equal(unrestricted.isWorkspaceAllowed('any-workspace'), true);
});
