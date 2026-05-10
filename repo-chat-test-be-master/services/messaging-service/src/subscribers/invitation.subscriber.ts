import { getNatsConnection } from '../lib/nats.js';
import { JSONCodec } from 'nats';
import { logger } from '../lib/logger.js';
import { WorkspaceService } from '../services/workspace.service.js';
import { prisma } from '../lib/prisma.js';

const jc = JSONCodec();
const workspaceService = new WorkspaceService();

export function startInvitationSubscriber() {
  const nc = getNatsConnection();
  if (!nc) return;

  // Handle both new user acceptance and existing user joining
  const subjects = ['invitation.accepted', 'invitation.joined'];
  
  for (const subject of subjects) {
    const sub = nc.subscribe(subject);
    logger.info({ subject }, '[InvitationSubscriber] Subscribed');

    (async () => {
      for await (const m of sub) {
        try {
          const data = jc.decode(m.data) as any;
          const payload = data.payload || data; // Handle both wrapped and unwrapped payloads

          if (!payload || !payload.userId) continue;

          logger.info({ subject, userId: payload.userId, workspaceId: payload.workspaceId }, '[InvitationSubscriber] Processing invitation event');

          const { userId, workspaceId, role, channelIds, invitedBy } = payload;

          if (workspaceId) {
            // 1. Add to workspace
            const targetRole = (role || 'WORKSPACE_MEMBER') as any;

            try {
              await workspaceService.addMember(workspaceId, userId, targetRole, invitedBy);
              logger.info({ userId, workspaceId, role: targetRole }, '[InvitationSubscriber] Added user to workspace');
            } catch (err: any) {
              // If already a member, ignore
              if (err.message?.includes('already a member')) {
                logger.warn({ userId, workspaceId }, '[InvitationSubscriber] User already a member of workspace');
              } else {
                throw err;
              }
            }

            // 2. Add to channels
            if (channelIds && Array.isArray(channelIds)) {
              for (const channelId of channelIds) {
                try {
                  await prisma.channelMember.upsert({
                    where: {
                      channelId_userId: { channelId, userId }
                    },
                    update: {},
                    create: {
                      channelId,
                      userId,
                      role: 'CHANNEL_MEMBER'
                    }
                  });
                } catch (err) {
                  logger.error({ err, channelId, userId }, '[InvitationSubscriber] Failed to add user to channel');
                }
              }
              logger.info({ userId, count: channelIds.length }, '[InvitationSubscriber] Added user to channels');
            }
          }
        } catch (err) {
          logger.error({ err, subject }, '[InvitationSubscriber] Failed to process invitation event');
        }
      }
    })();
  }
}
