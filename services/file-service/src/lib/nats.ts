import { connect, NatsConnection, JSONCodec } from 'nats';
import { logger } from './logger.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export const EventSubjects = {
  FILE_UPLOADED: 'file.uploaded',
  FILE_DELETED: 'file.deleted',
  DOCUMENT_UPLOADED: 'file.document.uploaded',
  CHAT_FILE_UPLOADED : 'file.chat.upload',
  USER_AVATAR_UPDATED: 'user.avatar.updated',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  natsConnection = await connect({
    servers: process.env.NATS_URL || 'nats://localhost:4222',
    name: 'file-service',
    reconnect: true,
    maxReconnectAttempts: 10,
  });

  logger.info('NATS connected');
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
  natsConnection.publish(
    subject,
    jsonCodec.encode({ subject, payload, timestamp: new Date().toISOString() })
  );
}
