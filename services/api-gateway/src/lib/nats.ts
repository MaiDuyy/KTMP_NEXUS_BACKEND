import { connect, NatsConnection, JSONCodec, Subscription } from 'nats';
import { logger } from './logger.js';
import type { NatsEvent, EventSubject } from '@ott/shared';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
  
  try {
    natsConnection = await connect({
      servers: natsUrl,
      name: 'api-gateway',
      reconnect: true,
      maxReconnectAttempts: 10,
      reconnectTimeWait: 2000,
    });

    logger.info(`NATS connected to ${natsUrl}`);

    (async () => {
      for await (const status of natsConnection!.status()) {
        logger.info({ type: status.type, data: status.data }, 'NATS status');
      }
    })();

    return natsConnection;
  } catch (error) {
    logger.error(error, 'Failed to connect to NATS');
    throw error;
  }
}

export function getNatsConnection(): NatsConnection {
  if (!natsConnection) {
    throw new Error('NATS not connected. Call connectNats() first.');
  }
  return natsConnection;
}

export async function disconnectNats(): Promise<void> {
  if (natsConnection) {
    await natsConnection.drain();
    natsConnection = null;
    logger.info('NATS disconnected');
  }
}

export async function publishEvent<T>(
  subject: EventSubject,
  payload: T,
  correlationId?: string
): Promise<void> {
  const nc = getNatsConnection();
  
  const event: NatsEvent<T> = {
    subject,
    payload,
    timestamp: new Date().toISOString(),
    correlationId,
  };

  nc.publish(subject, jsonCodec.encode(event));
  logger.debug({ subject, correlationId }, 'Published event to NATS');
}

export function subscribeEvent<T>(
  subject: string,
  handler: (event: NatsEvent<T>) => Promise<void>
): Subscription {
  const nc = getNatsConnection();
  const sub = nc.subscribe(subject);

  (async () => {
    for await (const msg of sub) {
      try {
        const event = jsonCodec.decode(msg.data) as NatsEvent<T>;
        await handler(event);
      } catch (error) {
        logger.error(error, `Error processing NATS message on ${subject}`);
      }
    }
  })();

  logger.info({ subject }, 'Subscribed to NATS subject');
  return sub;
}

export async function requestReply<TReq, TRes>(
  subject: string,
  payload: TReq,
  timeoutMs: number = 5000
): Promise<TRes> {
  const nc = getNatsConnection();
  
  const response = await nc.request(
    subject,
    jsonCodec.encode(payload),
    { timeout: timeoutMs }
  );

  return jsonCodec.decode(response.data) as TRes;
}
