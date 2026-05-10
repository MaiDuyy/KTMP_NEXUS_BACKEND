import { connect, NatsConnection, StringCodec, JSONCodec } from 'nats';
import { logger } from './logger.js';

let nc: NatsConnection | null = null;
const sc = StringCodec();
const jc = JSONCodec();

export async function connectNats(): Promise<NatsConnection> {
  if (nc) return nc;
  
  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
  
  try {
    nc = await connect({ servers: natsUrl });
    logger.info({ url: natsUrl }, 'Connected to NATS');
    return nc;
  } catch (error) {
    logger.error({ error, url: natsUrl }, 'Failed to connect to NATS');
    throw error;
  }
}

export async function disconnectNats(): Promise<void> {
  if (nc) {
    await nc.drain();
    nc = null;
    logger.info('Disconnected from NATS');
  }
}

export function getNatsConnection(): NatsConnection | null {
  return nc;
}

// Event subjects for RBAC
export const RBACEventSubjects = {
  ROLE_CREATED: 'rbac.role.created',
  ROLE_UPDATED: 'rbac.role.updated',
  ROLE_DELETED: 'rbac.role.deleted',
  ROLE_ASSIGNED: 'rbac.role.assigned',
  ROLE_REVOKED: 'rbac.role.revoked',
  PERMISSION_GRANTED: 'rbac.permission.granted',
  PERMISSION_REVOKED: 'rbac.permission.revoked',
} as const;

// Publish an event
export async function publishEvent<T>(subject: string, data: T): Promise<void> {
  if (!nc) {
    logger.warn('NATS not connected, skipping event publish');
    return;
  }
  
  try {
    nc.publish(subject, jc.encode(data));
    logger.debug({ subject, data }, 'Event published');
  } catch (error) {
    logger.error({ error, subject }, 'Failed to publish event');
  }
}
