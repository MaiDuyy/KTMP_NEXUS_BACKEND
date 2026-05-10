// services/messaging-service/src/subscribers/file.subscriber.ts
// File upload subscriber — migrated from chat-service

import { JSONCodec } from 'nats';
import { getNatsConnection, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { messageService } from '../services/message.service.js';

const jsonCodec = JSONCodec();

export function startFileSubscriber() {
  const nats = getNatsConnection();
  if (!nats) {
    logger.error('NATS connection not available for file subscriber');
    return;
  }

  const sub = nats.subscribe(EventSubjects.CHAT_FILE_UPLOADED);

  (async () => {
    for await (const msg of sub) {
      try {
        const decoded = jsonCodec.decode(msg.data) as any;
        const payload = decoded.payload;

        logger.info({ fileId: payload.fileId, chatId: payload.chatId }, 'Received CHAT_FILE_UPLOADED event');

        let messageType = 'file';
        if (payload.mimeType?.startsWith('image/')) messageType = 'image';
        else if (payload.mimeType?.startsWith('video/')) messageType = 'video';
        else if (payload.mimeType?.startsWith('audio/')) messageType = 'audio';

        await messageService.sendMessage(payload.chatId, payload.userId, {
          content: payload.url,
          type: messageType,
          fileName: payload.originalName,
          fileSize: payload.size?.toString() || '',
          fileType: payload.mimeType,
        });

        logger.info({ chatId: payload.chatId, fileId: payload.fileId }, 'Automatically created file message');
      } catch (error) {
        logger.error({ error }, 'Error processing CHAT_FILE_UPLOADED event');
      }
    }
  })();

  logger.info('Started File subscriber');
}
