// services/messaging-service/src/lib/nats.ts
// Unified NATS events from both chat-service and group-service

import { connect, type NatsConnection, JSONCodec } from 'nats';
import { logger } from './logger.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export const EventSubjects = {
  // ===== Message events (from chat-service) =====
  MESSAGE_CREATED: 'message.created',
  MESSAGE_UPDATED: 'message.updated',
  MESSAGE_DELETED: 'message.deleted',
  MESSAGE_READ: 'message.read',
  MESSAGE_REACTION: 'message.reaction',
  MESSAGE_EDITED: 'message.edited',

  // Thread events
  THREAD_REPLY_CREATED: 'thread.reply.created',

  // Mention events
  USER_MENTIONED: 'user.mentioned',
  MENTION_BROADCAST: 'mention.broadcast',

  // File events
  CHAT_FILE_UPLOADED: 'file.chat.upload',

  // ===== Group events (from group-service) =====
  GROUP_CREATED: 'group.created',
  GROUP_UPDATED: 'group.updated',
  GROUP_DELETED: 'group.deleted',
  GROUP_MEMBER_ADDED: 'group.member.added',
  GROUP_MEMBER_REMOVED: 'group.member.removed',
  GROUP_MEMBER_ROLE_UPDATED: 'group.member.role.updated',

  // Workspace events
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_DELETED: 'workspace.deleted',
  WORKSPACE_MEMBER_ADDED: 'workspace.member.added',
  WORKSPACE_MEMBER_REMOVED: 'workspace.member.removed',
  WORKSPACE_INVITE_CREATED: 'workspace.invite.created',
  WORKSPACE_INVITE_ACCEPTED: 'workspace.invite.accepted',
  WORKSPACE_INVITE_REJECTED: 'workspace.invite.rejected',
  WORKSPACE_INVITE_CANCELLED: 'workspace.invite.cancelled',
  WORKSPACE_MEMBER_ROLE_UPDATED: 'workspace.member.role.updated',
  WORKSPACE_DISSOLVED: 'workspace.dissolved',
  WORKSPACE_RESTORED: 'workspace.restored',
  WORKSPACE_MEMBER_KICKED: 'workspace.member.kicked',
  WORKSPACE_MEMBER_LEFT: 'workspace.member.left',
  WORKSPACE_OWNER_TRANSFERRED: 'workspace.owner.transferred',
  WORKSPACE_ROLE_ASSIGNED: 'workspace.role.assigned',
  WORKSPACE_ROLE_REVOKED: 'workspace.role.revoked',

  // Channel events
  CHANNEL_CREATED: 'channel.created',
  CHANNEL_UPDATED: 'channel.updated',
  CHANNEL_DELETED: 'channel.deleted',
  CHANNEL_ARCHIVED: 'channel.archived',
  CHANNEL_MEMBER_ADDED: 'channel.member.added',
  CHANNEL_MEMBER_REMOVED: 'channel.member.removed',

  // Join Request events
  GROUP_JOIN_REQUEST_CREATED: 'group.join.request.created',
  GROUP_JOIN_REQUEST_UPDATED: 'group.join.request.updated',

  // Task events
  TASK_CREATED: 'task.created',
  TASK_UPDATED: 'task.updated',
  TASK_DELETED: 'task.deleted',
  TASK_DEADLINE_APPROACHING: 'task.deadline.approaching',

  // Friend events
  FRIEND_REQUEST_SENT: 'friend.request.sent',
  FRIEND_REQUEST_ACCEPTED: 'friend.request.accepted',
  FRIEND_UNFRIENDED: 'friend.unfriended',
  FRIEND_USER_BLOCKED: 'friend.user.blocked',
  FRIEND_USER_UNBLOCKED: 'friend.user.unblocked',

  DEPARTMENT_MEMBER_ADDED: 'department.member.added',
  DEPARTMENT_MEMBER_REMOVED: 'department.member.removed',
  POLL_CREATED: 'poll.created',
  POLL_UPDATED: 'poll.updated',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

  natsConnection = await connect({
    servers: natsUrl,
    name: 'messaging-service',
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
  if (!natsConnection) return;

  try {
    natsConnection.publish(
      subject,
      jsonCodec.encode({
        subject,
        payload,
        timestamp: new Date().toISOString(),
      })
    );
    logger.debug({ subject }, 'Event published');
  } catch (error) {
    logger.error({ error, subject }, 'Failed to publish event');
  }
}
