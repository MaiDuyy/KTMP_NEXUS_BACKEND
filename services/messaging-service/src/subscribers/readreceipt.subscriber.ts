// services/messaging-service/src/subscribers/readreceipt.subscriber.ts
// Read receipt subscriber — migrated from chat-service

import { JSONCodec } from 'nats';
import { readReceiptService } from '../services/readreceipt.service.js';
import { logger } from '../lib/logger.js';
import { getNatsConnection } from '../lib/nats.js';

const jsonCodec = JSONCodec();

export async function startReadReceiptSubscriber() {
  const nc = getNatsConnection();
  if (!nc) return;

  const subject = 'message.mark_as_read';
  const sub = nc.subscribe(subject, { queue: 'messaging-service-read-receipt' });

  logger.info(`[NATS] Subscribed to ${subject}`);

  (async () => {
    for await (const msg of sub) {
      try {
        const data = jsonCodec.decode(msg.data) as any;
        const { chatId, userId, messageId } = data.payload;

        if (!chatId || !userId) {
          logger.warn('[NATS] Invalid read receipt payload', data.payload);
          continue;
        }

        logger.info({ chatId, userId, messageId }, '[NATS] Processing markAsRead request');
        await readReceiptService.markAsRead(chatId, userId, messageId);
      } catch (error: any) {
        logger.error({ error: error.message }, '[NATS] Error processing markAsRead');
      }
    }
  })();
}
