import { getNatsConnection, EventSubjects } from '../lib/nats.js';
import { JSONCodec } from 'nats';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

const jc = JSONCodec();

export function startWorkspaceRoleSubscriber() {
  const nc = getNatsConnection();
  if (!nc) {
    logger.error('NATS connection not available for workspace role subscriber');
    return;
  }

  // Subscribe to WORKSPACE_ROLE_ASSIGNED
  const assignedSubject = EventSubjects.WORKSPACE_ROLE_ASSIGNED;
  const assignedSub = nc.subscribe(assignedSubject);
  logger.info({ subject: assignedSubject }, '[WorkspaceRoleSubscriber] Subscribed');

  (async () => {
    for await (const m of assignedSub) {
      try {
        const data = jc.decode(m.data) as any;
        const payload = data.payload;
        if (!payload) continue;

        const { userId, workspaceId } = payload;
        if (!userId || !workspaceId) continue;

        logger.info({ userId, workspaceId }, '[WorkspaceRoleSubscriber] Processing workspace role assigned');

        // Idempotency: upsert the WorkspaceMember with WORKSPACE_ADMIN role
        const existingMember = await prisma.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId } }
        });

        if (existingMember) {
          await prisma.workspaceMember.update({
            where: { id: existingMember.id },
            data: { role: 'WORKSPACE_ADMIN', leftAt: null, leftReason: null }
          });
          logger.info({ workspaceId, userId }, '[WorkspaceRoleSubscriber] Updated existing member to WORKSPACE_ADMIN');
        } else {
          await prisma.workspaceMember.create({
            data: {
              workspaceId,
              userId,
              role: 'WORKSPACE_ADMIN',
            }
          });

          // Auto-join default channels of this workspace
          const defaultChannels = await prisma.channel.findMany({
            where: { workspaceId, isDefault: true, isArchived: false }
          });

          for (const channel of defaultChannels) {
            try {
              await prisma.channelMember.upsert({
                where: { channelId_userId: { channelId: channel.id, userId } },
                update: {},
                create: { channelId: channel.id, userId, role: 'CHANNEL_MEMBER' }
              });

              await prisma.chatParticipant.upsert({
                where: { chatId_accountId: { chatId: channel.id, accountId: userId } },
                update: { hidden: false },
                create: { chatId: channel.id, accountId: userId, role: 'CHANNEL_MEMBER' }
              });
            } catch (err: any) {
              logger.warn({ err: err.message, channelId: channel.id, userId }, '[WorkspaceRoleSubscriber] Failed to auto-join channel');
            }
          }

          logger.info({ workspaceId, userId }, '[WorkspaceRoleSubscriber] Created new workspace member as WORKSPACE_ADMIN and joined default channels');
        }
      } catch (err) {
        logger.error({ err }, '[WorkspaceRoleSubscriber] Failed to process workspace role assigned event');
      }
    }
  })();

  // Subscribe to WORKSPACE_ROLE_REVOKED
  const revokedSubject = EventSubjects.WORKSPACE_ROLE_REVOKED;
  const revokedSub = nc.subscribe(revokedSubject);
  logger.info({ subject: revokedSubject }, '[WorkspaceRoleSubscriber] Subscribed');

  (async () => {
    for await (const m of revokedSub) {
      try {
        const data = jc.decode(m.data) as any;
        const payload = data.payload;
        if (!payload) continue;

        const { userId, workspaceId } = payload;
        if (!userId || !workspaceId) continue;

        logger.info({ userId, workspaceId }, '[WorkspaceRoleSubscriber] Processing workspace role revoked');

        // Revoke: downgrade to WORKSPACE_MEMBER
        const existingMember = await prisma.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId } }
        });

        if (existingMember && existingMember.role === 'WORKSPACE_ADMIN') {
          await prisma.workspaceMember.update({
            where: { id: existingMember.id },
            data: { role: 'WORKSPACE_MEMBER' }
          });
          logger.info({ workspaceId, userId }, '[WorkspaceRoleSubscriber] Downgraded workspace member role to WORKSPACE_MEMBER');
        }
      } catch (err) {
        logger.error({ err }, '[WorkspaceRoleSubscriber] Failed to process workspace role revoked event');
      }
    }
  })();
}
