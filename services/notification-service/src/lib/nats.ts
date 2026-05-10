// services/notification-service/src/lib/nats.ts

import { connect, NatsConnection, JSONCodec, Subscription } from 'nats';
import { logger } from './logger.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

// Events that notification-service listens to
export const EventSubjects = {
  // User events
  USER_CREATED: 'user.created',
  // Friend events
  FRIEND_REQUEST_SENT: 'friend.request.sent',
  FRIEND_REQUEST_ACCEPTED: 'friend.request.accepted',
  FRIEND_REQUEST_REJECTED: 'friend.request.rejected',
  FRIEND_REQUEST_CANCELLED: 'friend.request.cancelled',
  FRIEND_UNFRIENDED: 'friend.unfriended',
  FRIEND_USER_BLOCKED: 'friend.user.blocked',
  FRIEND_USER_UNBLOCKED: 'friend.user.unblocked',
  
  // Message events
  MESSAGE_SENT: 'message.sent',
  MESSAGE_REACTION: 'message.reaction',
  USER_MENTIONED: 'user.mentioned',
  MENTION_BROADCAST: 'mention.broadcast',
  
  // Group events
  GROUP_INVITE: 'group.invite',
  GROUP_MEMBER_REMOVED: 'group.member.removed',
  GROUP_MENTION: 'group.mention',
  
  // Workspace events
  WORKSPACE_INVITE_CREATED: 'workspace.invite.created',
  
  // System events
  SYSTEM_NOTIFICATION: 'system.notification',
  SYSTEM_BROADCAST: 'system.broadcast',
  
  // Notification commands
  NOTIFICATION_CREATED: 'notification.created',
  NOTIFICATION_SEND: 'notification.send',
  NOTIFICATION_READ: 'notification.read',
  NOTIFICATION_DELETE: 'notification.delete',
  
  // OTP events
  OTP_SEND: 'otp.send',
  
  // Invitation events
  INVITATION_SEND: 'invitation.send',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

  natsConnection = await connect({
    servers: natsUrl,
    name: 'notification-service',
    reconnect: true,
    maxReconnectAttempts: 10,
    reconnectTimeWait: 2000,
  });

  logger.info(`NATS connected to ${natsUrl}`);
  return natsConnection;
}

export function getNatsConnection(): NatsConnection | null {
  return natsConnection;
}

export async function disconnectNats(): Promise<void> {
  if (natsConnection) {
    await natsConnection.drain();
    natsConnection = null;
    logger.info('NATS disconnected');
  }
}

export async function publishEvent<T>(subject: EventSubject, payload: T): Promise<void> {
  if (!natsConnection) return;

  try {
    natsConnection.publish(
      subject,
      jsonCodec.encode({
        subject,
        payload,
        timestamp: new Date().toISOString(),
      })
    );
    logger.debug({ subject }, 'Event published');
  } catch (error) {
    logger.error({ error, subject }, 'Failed to publish event');
  }
}

export function subscribe<T>(
  subject: EventSubject,
  handler: (data: T) => Promise<void>
): Subscription | null {
  if (!natsConnection) return null;

  const subscription = natsConnection.subscribe(subject);
  
  (async () => {
    for await (const msg of subscription) {
      try {
        const decoded = jsonCodec.decode(msg.data) as any;
        const payload = decoded.payload !== undefined ? decoded.payload : decoded;
        await handler(payload);
      } catch (error: any) {
        logger.error({ 
          error: error.message || error, 
          stack: error.stack,
          subject,
          data: jsonCodec.decode(msg.data)
        }, 'Failed to process message');
      }
    }
  })();

  logger.info({ subject }, 'Subscribed to topic');
  return subscription;
}
