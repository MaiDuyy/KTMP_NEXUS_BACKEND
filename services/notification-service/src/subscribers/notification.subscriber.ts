// services/notification-service/src/subscribers/notification.subscriber.ts
// Event subscribers for notification-service

import { subscribe, EventSubjects } from '../lib/nats.js';
import { notificationService } from '../services/notification.service.js';
import { emailService } from '../services/email.service.js';
import { logger } from '../lib/logger.js';

interface FriendRequestEvent {
  senderId: string;
  receiverId: string;
  senderName: string;
}

interface MessageEvent {
  chatId: string;
  workspaceId?: string | null;
  senderId: string;
  senderName?: string;
  sender?: { name: string };
  participantIds: string[];
  content?: string;
}

interface GroupInviteEvent {
  groupId: string;
  groupName: string;
  inviterId: string;
  inviterName: string;
  inviteeId: string;
}

interface MentionEvent {
  chatId: string;
  chatName: string;
  senderId: string;
  senderName: string;
  mentionedUserId: string;
}

export function setupSubscribers() {
  // Friend request sent
  subscribe<FriendRequestEvent>(EventSubjects.FRIEND_REQUEST_SENT, async (data) => {
    await notificationService.create({
      userId: data.receiverId,
      type: 'FRIEND_REQUEST',
      title: 'Lời mời kết bạn',
      body: `${data.senderName} đã gửi lời mời kết bạn`,
      data: { senderId: data.senderId },
    });
  });

  // Friend request accepted
  subscribe<FriendRequestEvent>(EventSubjects.FRIEND_REQUEST_ACCEPTED, async (data) => {
    await notificationService.create({
      userId: data.senderId,
      type: 'FRIEND_ACCEPTED',
      title: 'Lời mời được chấp nhận',
      body: `${data.senderName} đã chấp nhận lời mời kết bạn của bạn`,
      data: { friendId: data.receiverId },
    });
  });

  // New message (using unified MESSAGE_CREATED)
  subscribe<any>(EventSubjects.MESSAGE_CREATED, async (data) => {
    const senderName = data.senderName || data.sender?.name || 'Ai đó';
    const preview = data.content || 'Đã gửi một tin nhắn';
    const participantIds = data.participantIds || [];
    const mentionedUserIds = data.mentionedUserIds || [];

    for (const receiverId of participantIds) {
      // Skip if it's the sender
      if (receiverId === data.senderId) continue;

      // Skip if the user was already mentioned (they will get a MENTION notification instead)
      if (mentionedUserIds.includes(receiverId)) {
        logger.debug({ userId: receiverId, messageId: data.id }, 'Skipping NEW_MESSAGE notification for mentioned user');
        continue;
      }

      await notificationService.create({
        userId: receiverId,
        type: 'NEW_MESSAGE',
        title: senderName,
        body: preview.substring(0, 100),
        data: { 
          chatId: data.chatId, 
          senderId: data.senderId,
          workspaceId: data.workspaceId
        },
      });
    }
  });

  // Group invite
  subscribe<GroupInviteEvent>(EventSubjects.GROUP_INVITE, async (data) => {
    await notificationService.create({
      userId: data.inviteeId,
      type: 'GROUP_INVITE',
      title: 'Mời vào nhóm',
      body: `${data.inviterName} đã mời bạn vào nhóm ${data.groupName}`,
      data: { groupId: data.groupId, inviterId: data.inviterId },
    });
  });

  // Mention in group
  subscribe<any>(EventSubjects.USER_MENTIONED, async (data) => {
    const { userId, senderName, chatName, chatId, senderId } = data;
    await notificationService.create({
      userId: userId,
      type: 'MENTION',
      title: chatName ? `Nhắc đến trong ${chatName}` : 'Bạn được nhắc đến',
      body: `${senderName || 'Ai đó'} đã nhắc đến bạn`,
      data: { chatId, senderId },
    });
  });

  // Broadcast mention (@here/@channel)
  subscribe<any>(EventSubjects.MENTION_BROADCAST, async (data) => {
    const { chatId, chatName, senderName, senderId, types, participantIds } = data;
    
    if (!participantIds || !Array.isArray(participantIds)) return;

    const mentionTypeLabel = types.includes('ALL') ? '@all' : types.includes('CHANNEL') ? '@channel' : '@here';

    for (const userId of participantIds) {
      await notificationService.create({
        userId,
        type: 'MENTION',
        title: chatName ? `${mentionTypeLabel} trong ${chatName}` : `${mentionTypeLabel}`,
        body: `${senderName || 'Ai đó'} đã nhắc đến mọi người`,
        data: { chatId, senderId, broadcast: true },
      });
    }
    
    logger.info({ chatId, types, count: participantIds.length }, 'Broadcast mention notifications created');
  });

  // Workspace invite
 subscribe<any>(EventSubjects.WORKSPACE_INVITE_CREATED, async (data) => {
    const { inviteeId, workspaceName, email, token, workspaceId, role } = data; // Thêm role nếu có

    if (inviteeId) {
      await notificationService.create({
        userId: inviteeId,
        type: 'WORKSPACE_INVITE',
        title: 'Mời vào Workspace',
        body: `Bạn được mời tham gia không gian làm việc ${workspaceName}`,
        data: { 
       workspaceId:   workspaceId, 
         token :  token,
        email: email,
          role:role,
          // Thêm phần action vào đây để lưu trữ
          action: {
            type: 'NAVIGATE', // Định nghĩa loại action để frontend dễ xử lý
            label: 'Tham gia ngay',
            url: `/invite?token=${token}`
          }
        },
      });
    }
    
    // Here we would also trigger a real email via nodemailer or AWS SES
    logger.info({ email, workspace: workspaceName, hasUser: !!inviteeId }, 'Workspace invitation notification processed');
  });

  // System broadcast
  subscribe<any>(EventSubjects.SYSTEM_BROADCAST, async (data) => {
    const { title, body, type, data: extraData } = data;
    await notificationService.broadcast({
      title,
      body,
      type: type || 'SYSTEM',
      data: extraData,
    });
    logger.info({ title }, 'Processed system broadcast event');
  });

  // Invitation email send
  subscribe<any>(EventSubjects.INVITATION_SEND, async (data) => {
    logger.info({ to: data.to }, 'Received invitation email send event');
    await emailService.sendInvitationEmail(data);
  });

  logger.info('Notification subscribers initialized');
}
