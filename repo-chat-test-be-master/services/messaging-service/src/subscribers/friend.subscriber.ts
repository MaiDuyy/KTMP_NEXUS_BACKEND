import { getNatsConnection, EventSubjects } from '../lib/nats.js';
import { JSONCodec } from 'nats';
import { logger } from '../lib/logger.js';
import { ChatService } from '../services/chat.service.js';

const jc = JSONCodec();
const chatService = new ChatService();

export function startFriendSubscriber() {
  const nc = getNatsConnection();
  if (!nc) return;

  // Listen for friend request acceptance to create a private chat
  const sub = nc.subscribe(EventSubjects.FRIEND_REQUEST_ACCEPTED);
  logger.info({ subject: EventSubjects.FRIEND_REQUEST_ACCEPTED }, '[FriendSubscriber] Subscribed');

  (async () => {
    for await (const m of sub) {
      try {
        const data = jc.decode(m.data) as any;
        const { senderId, receiverId } = data.payload;

        if (senderId && receiverId) {
          logger.info({ senderId, receiverId }, '[FriendSubscriber] Friend request accepted, creating private chat');
          
          const result = await chatService.getOrCreatePrivateChat(senderId, receiverId);
          
          if (result.created) {
            logger.info({ chatId: result.chat.id }, '[FriendSubscriber] New private chat created for friends');
          } else {
            logger.info({ chatId: result.chat.id }, '[FriendSubscriber] Private chat already exists for friends');
          }
        }
      } catch (err) {
        logger.error({ err }, '[FriendSubscriber] Failed to process friend request acceptance');
      }
    }
  })();
}
