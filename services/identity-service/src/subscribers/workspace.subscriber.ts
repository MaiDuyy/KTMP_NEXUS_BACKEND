import { getNatsConnection } from '../lib/nats.js';
import { JSONCodec } from 'nats';
import { logger } from '../lib/logger.js';
import { rbacPrisma } from '../lib/prisma.js';
import { messagingGrpc } from '../lib/messagingClient.js';

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

        const { id: workspaceId, createdBy: userId, departmentId } = payload;

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

        // Auto-add all members of the department to this new workspace
        if (departmentId) {
          logger.info({ departmentId, workspaceId }, '[WorkspaceSubscriber] Fetching department members to populate workspace');
          const deptMembers = await rbacPrisma.departmentMember.findMany({
            where: { departmentId },
          });

          for (const member of deptMembers) {
            // Creator is already the owner of the workspace, skip
            if (member.userId === userId) continue;

            try {
              logger.info({ workspaceId, memberId: member.userId }, '[WorkspaceSubscriber] Auto-adding department member to workspace');
              await messagingGrpc.addMember(workspaceId, member.userId, 'WORKSPACE_MEMBER', userId);
            } catch (err: any) {
              logger.error({ err: err.message, workspaceId, memberId: member.userId }, '[WorkspaceSubscriber] Failed to auto-add member to workspace');
            }
          }
        }
      } catch (err) {
        logger.error({ err }, '[WorkspaceSubscriber] Failed to process workspace creation');
      }
    }
  })();
}
