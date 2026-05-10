import { getNatsConnection } from '../lib/nats.js';
import { JSONCodec } from 'nats';
import { logger } from '../lib/logger.js';
import { WorkspaceService } from '../services/workspace.service.js';

const jc = JSONCodec();
const workspaceService = new WorkspaceService();

export function startOrganizationSubscriber() {
  const nc = getNatsConnection();
  if (!nc) return;

  const subject = 'organization.created';
  const sub = nc.subscribe(subject);
  logger.info({ subject }, '[OrganizationSubscriber] Subscribed');

  (async () => {
    for await (const m of sub) {
      try {
        const data = jc.decode(m.data) as any;
        const payload = data.payload;

        if (!payload) continue;

        logger.info({ payload }, '[OrganizationSubscriber] Received organization created event');

        // Create default workspace for the new organization
        // Note: The workspace name and slug are based on organization data
        const wsName = payload.workspaceName || payload.orgName || 'General';
        const wsSlug = (payload.orgName || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).substring(2, 5);

        await workspaceService.createWorkspace({
          name: wsName,
          description: `Workspace mặc định của ${payload.orgName}`,
          slug: wsSlug,
          isPublic: false
        }, payload.ownerId || payload.adminId);

        logger.info({ orgId: payload.orgId, workspaceName: wsName }, '[OrganizationSubscriber] Initialized default workspace');
      } catch (err) {
        logger.error({ err }, '[OrganizationSubscriber] Failed to process organization creation');
      }
    }
  })();
}
