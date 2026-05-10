// services/auth-service/src/lib/nats.ts

import { connect, NatsConnection, JSONCodec, Subscription } from 'nats';
import { logger } from './logger.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export const EventSubjects = {
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',
  USER_AVATAR_UPDATED: 'user.avatar.updated',
  OTP_SEND: 'otp.send',
  FILE_UPLOADED: 'file.uploaded',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

  natsConnection = await connect({
    servers: natsUrl,
    name: 'auth-service',
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
