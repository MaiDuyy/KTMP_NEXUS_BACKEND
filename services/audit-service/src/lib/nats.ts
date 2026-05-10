import { connect, NatsConnection, JSONCodec, Subscription } from 'nats';
import { logger } from './logger.js';

let nc: NatsConnection | null = null;
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

// Subscribe to events for audit logging
export async function subscribeToEvents(
  subjects: string[],
  handler: (subject: string, data: unknown) => Promise<void>
): Promise<Subscription[]> {
  if (!nc) throw new Error('NATS not connected');

  const subscriptions: Subscription[] = [];

  for (const subject of subjects) {
    const sub = nc.subscribe(subject);
    subscriptions.push(sub);
    
    (async () => {
      for await (const msg of sub) {
        try {
          const data = jc.decode(msg.data);
          await handler(msg.subject, data);
        } catch (error) {
          logger.error({ error, subject: msg.subject }, 'Event handler error');
        }
      }
    })();
    
    logger.info({ subject }, 'Subscribed to audit events');
  }

  return subscriptions;
}

// Audit-relevant event subjects to subscribe
export const AuditEventSubjects = [
  // Auth events
  'auth.user.created',
  'auth.user.login',
  'auth.user.logout',
  'auth.token.refresh',
  
  // RBAC events
  'rbac.role.created',
  'rbac.role.updated',
  'rbac.role.deleted',
  'rbac.role.assigned',
  'rbac.role.revoked',
  'rbac.permission.granted',
  'rbac.permission.revoked',
  
  // Knowledge events
  'knowledge.document.uploaded',
  'knowledge.document.indexed',
  'knowledge.document.deleted',
  'knowledge.acl.granted',
  'knowledge.acl.revoked',
  
  // Chat events
  'chat.message.sent',
  'chat.message.deleted',
  'chat.dm.accessed',
];
