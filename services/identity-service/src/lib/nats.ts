// services/identity-service/src/lib/nats.ts
// Unified NATS module — merges events from auth + userorg + rbac

import { connect, NatsConnection, JSONCodec } from 'nats';
import { logger } from './logger.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export const EventSubjects = {
  // Auth events
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',
  USER_AVATAR_UPDATED: 'user.avatar.updated',
  OTP_SEND: 'otp.send',
  FILE_UPLOADED: 'file.uploaded',

  // Friend events
  FRIEND_REQUEST_SENT: 'friend.request.sent',
  FRIEND_REQUEST_ACCEPTED: 'friend.request.accepted',
  FRIEND_REQUEST_REJECTED: 'friend.request.rejected',
  FRIEND_REQUEST_CANCELLED: 'friend.request.cancelled',
  FRIEND_UNFRIENDED: 'friend.unfriended',
  FRIEND_USER_BLOCKED: 'friend.user.blocked',
  FRIEND_USER_UNBLOCKED: 'friend.user.unblocked',

  // RBAC events
  ROLE_ASSIGNED: 'rbac.role.assigned',
  ROLE_REVOKED: 'rbac.role.revoked',
  PERMISSION_CHANGED: 'rbac.permission.changed',

  // Workspace events
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_DISSOLVED: 'workspace.dissolved',
  WORKSPACE_RESTORED: 'workspace.restored',
  WORKSPACE_MEMBER_LEFT: 'workspace.member.left',
  WORKSPACE_MEMBER_KICKED: 'workspace.member.kicked',
  WORKSPACE_QUOTA_UPDATED: 'workspace.quota.updated',
  WORKSPACE_INVITE_CREATED: 'workspace.invite.created',
  WORKSPACE_INVITE_REJECTED: 'workspace.invite.rejected',
  WORKSPACE_ROLE_ASSIGNED: 'workspace.role.assigned',
  WORKSPACE_ROLE_REVOKED: 'workspace.role.revoked',

  // Admin events
  SYSTEM_BROADCAST: 'system.broadcast',
  USER_INVITED: 'admin.user.invited',
  USER_ROLE_CHANGED: 'admin.user.role.changed',
  WORKSPACE_INVITE_REVOKED: 'admin.workspace.invite.revoked',
  ORG_SETTINGS_UPDATED: 'admin.org.settings.updated',
  AUDIT_LOG_CREATED: 'admin.audit_log.created',
  INVITATION_ACCEPTED: 'invitation.accepted',
  ORGANIZATION_CREATED: 'organization.created',

  DEPARTMENT_MEMBER_ADDED: 'department.member.added',
  DEPARTMENT_MEMBER_REMOVED: 'department.member.removed',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

  natsConnection = await connect({
    servers: natsUrl,
    name: 'identity-service',
    reconnect: true,
    maxReconnectAttempts: 10,
    reconnectTimeWait: 2000,
  });

  logger.info(`NATS connected to ${natsUrl}`);
  return natsConnection;
}

export function getNatsConnection(): NatsConnection | null {
  return natsConnection;
}

export async function disconnectNats(): Promise<void> {
  if (natsConnection) {
    await natsConnection.drain();
    natsConnection = null;
    logger.info('NATS disconnected');
  }
}

export async function publishEvent<T>(subject: string, payload: T): Promise<void> {
  if (!natsConnection) {
    logger.warn({ subject }, 'NATS not connected. Event NOT published.');
    return;
  }

  try {
    natsConnection.publish(
      subject,
      jsonCodec.encode({
        subject,
        payload,
        timestamp: new Date().toISOString(),
      })
    );
    await natsConnection.flush();
    logger.debug({ subject }, 'Event published and flushed');
  } catch (error) {
    logger.error({ error, subject }, 'Failed to publish event');
  }
}
