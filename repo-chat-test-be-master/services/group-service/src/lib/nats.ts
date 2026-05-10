// services/group-service/src/lib/nats.ts

import { connect, type NatsConnection, JSONCodec } from 'nats';
import { logger } from './logger.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export const EventSubjects = {
  // Group events (legacy)
  GROUP_CREATED: 'group.created',
  GROUP_UPDATED: 'group.updated',
  GROUP_DELETED: 'group.deleted',
  GROUP_MEMBER_ADDED: 'group.member.added',
  GROUP_MEMBER_REMOVED: 'group.member.removed',
  GROUP_MEMBER_ROLE_UPDATED: 'group.member.role.updated',
  MESSAGE_READ: 'message.read',
  
  // Workspace events (Module 4)
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_DELETED: 'workspace.deleted',
  WORKSPACE_MEMBER_ADDED: 'workspace.member.added',
  WORKSPACE_MEMBER_REMOVED: 'workspace.member.removed',
  
  // Channel events (Module 4)
  CHANNEL_CREATED: 'channel.created',
  CHANNEL_UPDATED: 'channel.updated',
  CHANNEL_DELETED: 'channel.deleted',
  CHANNEL_ARCHIVED: 'channel.archived',
  CHANNEL_MEMBER_ADDED: 'channel.member.added',
  CHANNEL_MEMBER_REMOVED: 'channel.member.removed',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

  natsConnection = await connect({
    servers: natsUrl,
    name: 'group-service',
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

export async function publishEvent<T>(subject: EventSubject, payload: T): Promise<void> {
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
