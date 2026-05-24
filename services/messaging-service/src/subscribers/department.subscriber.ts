import { getNatsConnection, EventSubjects } from '../lib/nats.js';
import { JSONCodec } from 'nats';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { workspaceService } from '../services/workspace.service.js';

const jc = JSONCodec();

export function startDepartmentSubscriber() {
  const nc = getNatsConnection();
  if (!nc) {
    logger.error('NATS connection not available for department subscriber');
    return;
  }

  // Subscribe to DEPARTMENT_MEMBER_ADDED
  const addedSubject = EventSubjects.DEPARTMENT_MEMBER_ADDED;
  const addedSub = nc.subscribe(addedSubject);
  logger.info({ subject: addedSubject }, '[DepartmentSubscriber] Subscribed');

  (async () => {
    for await (const m of addedSub) {
      try {
        const data = jc.decode(m.data) as any;
        const payload = data.payload;
        if (!payload) continue;

        const { departmentId, userId, role } = payload;
        if (!departmentId || !userId) continue;

        logger.info({ departmentId, userId }, '[DepartmentSubscriber] Processing member added to department');

        // Find all workspaces belonging to this department
        const workspaces = await prisma.workspace.findMany({
          where: { departmentId },
        });

        for (const ws of workspaces) {
          try {
            logger.info({ workspaceId: ws.id, userId }, '[DepartmentSubscriber] Auto-joining workspace on department join');
            await workspaceService.addMember(ws.id, userId, 'WORKSPACE_MEMBER');
          } catch (err: any) {
            logger.warn({ err: err.message, workspaceId: ws.id, userId }, '[DepartmentSubscriber] Skip or failed to add member to workspace');
          }
        }
      } catch (err) {
        logger.error({ err }, '[DepartmentSubscriber] Failed to process department member added event');
      }
    }
  })();

  // Subscribe to DEPARTMENT_MEMBER_REMOVED
  const removedSubject = EventSubjects.DEPARTMENT_MEMBER_REMOVED;
  const removedSub = nc.subscribe(removedSubject);
  logger.info({ subject: removedSubject }, '[DepartmentSubscriber] Subscribed');

  (async () => {
    for await (const m of removedSub) {
      try {
        const data = jc.decode(m.data) as any;
        const payload = data.payload;
        if (!payload) continue;

        const { departmentId, userId } = payload;
        if (!departmentId || !userId) continue;

        logger.info({ departmentId, userId }, '[DepartmentSubscriber] Processing member removed from department');

        // Find all workspaces belonging to this department
        const workspaces = await prisma.workspace.findMany({
          where: { departmentId },
        });

        for (const ws of workspaces) {
          try {
            logger.info({ workspaceId: ws.id, userId }, '[DepartmentSubscriber] Auto-removing workspace member on department leave');
            await workspaceService.removeMemberSystem(ws.id, userId);
          } catch (err: any) {
            logger.warn({ err: err.message, workspaceId: ws.id, userId }, '[DepartmentSubscriber] Failed to remove member from workspace');
          }
        }
      } catch (err) {
        logger.error({ err }, '[DepartmentSubscriber] Failed to process department member removed event');
      }
    }
  })();
}
