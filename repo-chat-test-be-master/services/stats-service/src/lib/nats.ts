import { connect, NatsConnection, JSONCodec, Subscription } from 'nats';
import { logger } from './logger.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export const EventSubjects = {
  USER_CREATED: 'user.created',
  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',
  MESSAGE_CREATED: 'message.created',
  GROUP_CREATED: 'group.created',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

interface NatsEvent<T = any> {
  subject: string;
  payload: T;
  timestamp: string;
}

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  natsConnection = await connect({
    servers: process.env.NATS_URL || 'nats://localhost:4222',
    name: 'stats-service',
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

export function subscribeEvent<T>(
  subject: string,
  handler: (event: NatsEvent<T>) => Promise<void>
): Subscription | null {
  if (!natsConnection) {
    logger.warn({ subject }, 'Cannot subscribe: NATS not connected');
    return null;
  }

  const sub = natsConnection.subscribe(subject);

  (async () => {
    for await (const msg of sub) {
      try {
        const event = jsonCodec.decode(msg.data) as NatsEvent<T>;
        await handler(event);
      } catch (error) {
        logger.error({ error, subject }, 'Error processing NATS message');
      }
    }
  })();

  logger.info({ subject }, 'Subscribed to NATS subject');
  return sub;
}
