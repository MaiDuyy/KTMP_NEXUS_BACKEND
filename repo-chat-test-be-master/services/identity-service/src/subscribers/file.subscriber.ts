// services/identity-service/src/subscribers/file.subscriber.ts
// Avatar subscriber — uses authPrisma (auth schema has Account)

import { JSONCodec } from 'nats';
import { getNatsConnection, EventSubjects, publishEvent } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { authPrisma, userorgPrisma } from '../lib/prisma.js';

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
          logger.info({ userId, url }, 'Updating user avatar');

          await authPrisma.account.update({
            where: { id: userId },
            data: { avatar: url },
          });

          // ⚡ SYNC: Update avatar in userorg schema
          await userorgPrisma.account.update({
            where: { id: userId },
            data: { avatar: url },
          }).catch(() => {});

          await publishEvent(EventSubjects.USER_AVATAR_UPDATED, { userId, avatar: url });
          logger.info({ userId, url }, 'User avatar updated via event');
        }
      } catch (error) {
        logger.error({ error }, 'Error processing FILE_UPLOADED event');
      }
    }
  })();

  logger.info('Started Avatar subscriber');
}
