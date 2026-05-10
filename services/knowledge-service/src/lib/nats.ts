import { connect, NatsConnection, JSONCodec } from 'nats';
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

// Event subjects for Knowledge
export const KnowledgeEventSubjects = {
  // Document events
  DOCUMENT_UPLOADED: 'knowledge.document.uploaded',
  DOCUMENT_PROCESSED: 'knowledge.document.processed',
  DOCUMENT_INDEXED: 'knowledge.document.indexed',
  DOCUMENT_DELETED: 'knowledge.document.deleted',
  DOCUMENT_FAILED: 'knowledge.document.failed',
  
  // Collection events
  COLLECTION_CREATED: 'knowledge.collection.created',
  COLLECTION_UPDATED: 'knowledge.collection.updated',
  COLLECTION_DELETED: 'knowledge.collection.deleted',
  
  // ACL events
  ACL_GRANTED: 'knowledge.acl.granted',
  ACL_REVOKED: 'knowledge.acl.revoked',
  
  // Sync events
  SYNC_STARTED: 'knowledge.sync.started',
  SYNC_COMPLETED: 'knowledge.sync.completed',
  SYNC_FAILED: 'knowledge.sync.failed',
} as const;

// Publish an event
export async function publishEvent<T>(subject: string, data: T): Promise<void> {
  if (!nc) {
    logger.warn('NATS not connected, skipping event publish');
    return;
  }
  
  try {
    nc.publish(subject, jc.encode(data));
    logger.debug({ subject }, 'Event published');
  } catch (error) {
    logger.error({ error, subject }, 'Failed to publish event');
  }
}

// Subscribe to a subject
export function subscribe(subject: string, callback: (data: any) => Promise<void>): void {
  if (!nc) {
    logger.warn('NATS not connected, cannot subscribe');
    return;
  }

  const sub = nc.subscribe(subject);
  (async () => {
    for await (const msg of sub) {
      try {
        const data = jc.decode(msg.data);
        await callback(data);
      } catch (error) {
        logger.error({ error, subject }, 'Failed to process NATS message');
      }
    }
  })();

  logger.info({ subject }, 'Subscribed to NATS subject');
}

// Common event subjects used across services
export const EventSubjects = {
  MESSAGE_CREATED: 'chat.message.created',
  MESSAGE_UPDATED: 'chat.message.updated',
  MESSAGE_DELETED: 'chat.message.deleted',
} as const;