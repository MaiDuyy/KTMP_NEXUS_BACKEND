// services/userorg-service/src/subscribers/avatar.subscriber.ts
import { JSONCodec } from 'nats';
import { getNatsConnection, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

const jsonCodec = JSONCodec();

export function startAvatarSubscriber() {
  const nats = getNatsConnection();
  if (!nats) {
    logger.error('NATS connection not available for avatar subscriber');
    return;
  }

const sub = nats.subscribe(EventSubjects.FILE_UPLOADED);

  (async () => {
    for await (const msg of sub) {
      try {
        const { payload } = jsonCodec.decode(msg.data) as any;
        
        if (payload.type === 'AVATAR') {
          const { userId, url } = payload;
          logger.info({ userId, url }, "Updating user avatar");

          // Cập nhật avatar trong DB
          await prisma.account.update({
            where: { id: userId },
            data: { avatar: url },
          });

          const { publishEvent } = await import('../lib/nats.js');
          await publishEvent(EventSubjects.USER_AVATAR_UPDATED, { userId, avatar: url });

          logger.info({ userId, url }, 'User avatar updated via event and published notification');
        }
      } catch (error) {
        logger.error({ error }, 'Error processing USER_AVATAR_UPDATED event');
      }
    }
  })();

  logger.info('Started Avatar subscriber');
}