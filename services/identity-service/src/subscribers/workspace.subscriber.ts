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

  // Subscribe to workspace.updated
  const updateSubject = 'workspace.updated';
  const updateSub = nc.subscribe(updateSubject);
  logger.info({ subject: updateSubject }, '[WorkspaceSubscriber] Subscribed to workspace.updated');

  (async () => {
    for await (const m of updateSub) {
      try {
        const data = jc.decode(m.data) as any;
        const payload = data.payload;
        if (!payload) continue;

        const { id: workspaceId, updates, updatedBy } = payload;
        if (!workspaceId) continue;

        const { departmentId, oldDepartmentId } = updates || {};
        if (departmentId === undefined && oldDepartmentId === undefined) continue;

        logger.info({ workspaceId, departmentId, oldDepartmentId }, '[WorkspaceSubscriber] Processing workspace department update');

        // Remove members of oldDepartmentId who are not in the new department
        if (oldDepartmentId && oldDepartmentId !== departmentId) {
          const oldDeptMembers = await rbacPrisma.departmentMember.findMany({
            where: { departmentId: oldDepartmentId },
            select: { userId: true },
          });
          const oldMemberIds = oldDeptMembers.map(m => m.userId);

          let newMemberIds: string[] = [];
          if (departmentId) {
            const newDeptMembers = await rbacPrisma.departmentMember.findMany({
              where: { departmentId },
              select: { userId: true },
            });
            newMemberIds = newDeptMembers.map(m => m.userId);
          }

          // Fetch Workspace Manager / Owner to avoid ejecting them
          const ownerRole = await rbacPrisma.role.findUnique({
            where: { name: 'WORKSPACE_MANAGER' },
            include: { userRoles: { where: { workspaceId } } }
          });
          const ownerIds = ownerRole?.userRoles.map(ur => ur.userId) || [];

          for (const memberId of oldMemberIds) {
            if (newMemberIds.includes(memberId)) continue;
            if (ownerIds.includes(memberId)) continue;

            try {
              logger.info({ workspaceId, memberId }, '[WorkspaceSubscriber] Auto-removing old department member from workspace');
              await messagingGrpc.kickMember(workspaceId, memberId, updatedBy || 'SYSTEM');
            } catch (err: any) {
              logger.warn({ err: err.message, workspaceId, memberId }, '[WorkspaceSubscriber] Failed to auto-remove member from workspace');
            }
          }
        }

        // Add members of the new department
        if (departmentId && departmentId !== oldDepartmentId) {
          const newDeptMembers = await rbacPrisma.departmentMember.findMany({
            where: { departmentId },
          });

          for (const member of newDeptMembers) {
            try {
              logger.info({ workspaceId, memberId: member.userId }, '[WorkspaceSubscriber] Auto-adding new department member to workspace');
              await messagingGrpc.addMember(workspaceId, member.userId, 'WORKSPACE_MEMBER', updatedBy || 'SYSTEM');
            } catch (err: any) {
              logger.debug({ err: err.message, workspaceId, memberId: member.userId }, '[WorkspaceSubscriber] Member already in workspace or fail');
            }
          }
        }
      } catch (err) {
        logger.error({ err }, '[WorkspaceSubscriber] Failed to process workspace update');
      }
    }
  })();
}
