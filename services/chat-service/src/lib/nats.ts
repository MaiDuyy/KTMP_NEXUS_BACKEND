// services/chat-service/src/lib/nats.ts

import { connect, NatsConnection, JSONCodec } from 'nats';
import { logger } from './logger.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export const EventSubjects = {
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
  CHAT_FILE_UPLOADED: 'file.chat.upload'
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

  natsConnection = await connect({
    servers: natsUrl,
    name: 'chat-service',
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
