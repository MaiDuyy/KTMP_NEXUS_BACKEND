import { getNatsConnection } from '../lib/nats.js';
import { JSONCodec } from 'nats';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const jc = JSONCodec();

export function startUserSubscriber() {
  const nc = getNatsConnection();
  if (!nc) return;

  // Listen for user updates to invalidate cache
  const subjects = [
    'user.updated',
    'user.online',
    'user.offline',
    'user.status.changed',
    'user.avatar.updated'
  ];

  subjects.forEach(subject => {
    const sub = nc.subscribe(subject);
    logger.info({ subject }, '[UserSubscriber] Subscribed to subject');

    (async () => {
      for await (const m of sub) {
        try {
          const data = jc.decode(m.data) as any;
          const payload = data.payload || data;
          const userId = payload.id || payload.userId;

          if (userId) {
            const cacheKey = `user:profile:${userId}`;
            await redis.del(cacheKey);
            logger.debug({ userId, subject }, '[UserSubscriber] Invalidated user profile cache');
          }
        } catch (err) {
          logger.error({ err, subject }, '[UserSubscriber] Failed to process message');
        }
      }
    })();
  });
}
