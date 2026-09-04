import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const plan = JSON.parse(await readFile(resolve(root, 'test-plan.json'), 'utf8'));
const endpoints = [
  ['frontend', process.env.P4C_FRONTEND_URL],
  ['gateway', process.env.P4C_GATEWAY_URL],
  ['voiceService', process.env.P4C_VOICE_SERVICE_URL],
  ['aiKnowledge', process.env.P4C_AI_KNOWLEDGE_URL],
  ['livekitHttp', process.env.P4C_LIVEKIT_HTTP_URL],
];
const requiredVariables = ['P4C_MEMBER_A', 'P4C_MEMBER_B', 'P4C_OUTSIDER_C'];

const endpointResults = await Promise.all(endpoints.map(async ([name, url]) => {
  if (!url) return { name, status: 'MISSING_URL' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { name, status: `HTTP_${response.status}` };
  } catch {
    return { name, status: 'UNREACHABLE' };
  }
}));

const missingActors = requiredVariables.filter((name) => !process.env[name]);
const blocked = endpointResults.some(({ status }) => !status.startsWith('HTTP_2')) || missingActors.length > 0;
console.log(JSON.stringify({
  phase: plan.phase,
  planStatus: plan.status,
  endpoints: endpointResults,
  actorVariableNamesMissing: missingActors,
  result: blocked ? 'BLOCKED' : 'PREFLIGHT_PASS',
}, null, 2));
process.exitCode = blocked ? 2 : 0;
