import { getNatsConnection } from '../lib/nats.js';
import { JSONCodec } from 'nats';
import { logger } from '../lib/logger.js';
import { rbacPrisma } from '../lib/prisma.js';

const jc = JSONCodec();

export function startWorkspaceSubscriber() {
  const nc = getNatsConnection();
  if (!nc) return;

  const subject = 'workspace.created';
  const sub = nc.subscribe(subject);
  logger.info({ subject }, '[WorkspaceSubscriber] Subscribed');

  (async () => {
    for await (const m of sub) {
      try {
        const data = jc.decode(m.data) as any;
        const payload = data.payload;

        if (!payload) continue;

        logger.info({ payload }, '[WorkspaceSubscriber] Received workspace created event');

        const { id: workspaceId, createdBy: userId } = payload;

        if (!workspaceId || !userId) {
          logger.warn({ payload }, '[WorkspaceSubscriber] Missing workspaceId or userId');
          continue;
        }

        // Assign WORKSPACE_MANAGER role in RBAC schema for this workspace
        const role = await rbacPrisma.role.findUnique({ where: { name: 'WORKSPACE_MANAGER' } });
        
        if (!role) {
          logger.error({ roleName: 'WORKSPACE_MANAGER' }, '[WorkspaceSubscriber] RBAC role not found');
          continue;
        }

        await rbacPrisma.userRole.create({
          data: {
            userId,
            roleId: role.id,
            workspaceId,
            grantedBy: 'SYSTEM_EVENT',
          },
        });

        logger.info({ userId, workspaceId }, '[WorkspaceSubscriber] Assigned WORKSPACE_MANAGER role');
      } catch (err) {
        logger.error({ err }, '[WorkspaceSubscriber] Failed to process workspace creation');
      }
    }
  })();
}
