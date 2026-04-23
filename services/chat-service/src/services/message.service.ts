// services/chat-service/src/services/message.service.ts
// Migrate từ src/controllers/message.controller.ts

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { groupChatClient } from '../lib/groupClient.js';
import { userorgClient } from '../lib/userorgClient.js';
import { mentionService } from './mention.service.js';

// Message types từ monolith
const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'file', 'sticker', 'gif', 'location', 'contact', 'system'];

export class MessageService {
  /**
   * Lấy tin nhắn của chat với pagination (cursor-based)
   */
  async getMessages(
    chatId: string,
    userId: string,
    options: { cursor?: string; limit?: number }
  ) {
    const { cursor, limit = 50 } = options;
    const take = Math.min(limit, 100);

    const whereCondition: any = {
      chatId,
      destroy: false,
      OR: [
        { deletedBy: null },
        { NOT: { deletedBy: { contains: userId } } },
      ],
    };

    if (cursor) {
      whereCondition.time = { lt: new Date(cursor) };
    }
    //  const participant = await prisma.chatParticipant.findFirst({
    //   where: { chatId, accountId: userId },
    // });
    const messages = await prisma.message.findMany({
      where: whereCondition,
      include: {
        replyTo: {
          select: {
            id: true,
            content: true,
            type: true,
            senderId: true,
          },
        },
        reactions: true,
      },
      orderBy: { time: 'desc' },
      take,
    });

    // Phủ thêm thông tin người gửi
    const hydratedMessages = await this.populateSenderInfo(messages);

    // Format messages
    const formattedMessages = hydratedMessages.map((msg) => {
      return {
        id: msg.id,
        content: msg.content,
        type: msg.type,
        time: msg.time,
        pin: msg.pin,
        senderId: msg.senderId,
        sender: msg.sender,
        replyTo: msg.replyTo
          ? {
              id: msg.replyTo.id,
              content: msg.replyTo.content,
              type: msg.replyTo.type,
              senderId: msg.replyTo.senderId,
            }
          : null,
        file: msg.fileName
          ? {
              name: msg.fileName,
              size: msg.fileSize,
              type: msg.fileType,
            }
          : null,
        reactions: this.groupReactions(msg.reactions),
        isMe: msg.senderId === userId,
      };
    });

    const lastMessage = messages[messages.length - 1];

    return {
      messages: formattedMessages.reverse(), // Chronological order
        nextCursor: messages.length === take && lastMessage ? lastMessage.time : null,
    };
  }

  /**
   * Gửi tin nhắn
   */
  async sendMessage(
    chatId: string,
    senderId: string,
    input: {
      content?: string;
      type?: string;
      replyToId?: string;
      fileName?: string;
      fileSize?: string;
      fileType?: string;
    }
  ) {
    const { content, type = 'text', replyToId, fileName, fileSize, fileType } = input;

    // CHỈ KIỂM TRA CHO TIN NHẮN THƯỜNG (không phải hệ thống) VÀ CHAT RIÊNG (DM)
    if (type !== 'system' && chatId) {
      // Lấy metadata chat từ group-service (Internal call qua HTTP)
      const chatMetadata = await groupChatClient.getChatMetadataInternal(chatId);

      if (chatMetadata && !chatMetadata.isGroup) {
        // Nếu là chat riêng, kiểm tra xem họ có bị chặn không
        const partner = chatMetadata.participants.find((p: any) => p.accountId !== senderId);

        if (partner) {
          // 1. Kiểm tra trạng thái Chặn (Ưu tiên hàng đầu)
          const isBlockedResult = await userorgClient.checkBlockedStatus(senderId, partner.accountId);
          if (isBlockedResult) {
            throw new Error('Bạn không thể gửi tin nhắn cho người này vì đã bị chặn hoặc bạn đã chặn người này!');
          }

          // 2. Kiểm tra quan hệ Bạn bè (Chỉ tin nhắn thường)
          const isFriendResult = await userorgClient.checkFriendship(senderId, partner.accountId);
          if (!isFriendResult) {
             // throw new Error('Chỉ bạn bè mới có thể gửi tin nhắn cho nhau!');
             // Để linh hoạt, tôi có thể chỉ log warning hoặc throw tùy theo yêu cầu của bạn
             // Hiện tại chỉ chặn cứng nếu bị BLOCK.
          }
        }
      }
    }

    // Validate
    if (!MESSAGE_TYPES.includes(type)) {
      throw new Error('Loại tin nhắn không hợp lệ!');
    }

    if (type === 'text' && (!content || content.trim().length === 0)) {
      throw new Error('Nội dung tin nhắn không được trống!');
    }

    // Verify replyTo exists
    if (replyToId) {
      const replyMessage = await prisma.message.findFirst({
        where: { id: replyToId, chatId },
      });
      if (!replyMessage) {
        throw new Error('Tin nhắn reply không tồn tại!');
      }
    }

    // Create message
    const message = await prisma.message.create({
      data: {
        id: uuidv4(),
        chatId,
        senderId,
        content: content?.trim() || null,
        type,
        replyToId: replyToId || null,
        fileName: fileName || null,
        fileSize: fileSize || null,
        fileType: fileType || null,
      },
      include: {
        replyTo: {
          select: {
            id: true,
            content: true,
            type: true,
            senderId: true,
          },
        },
      },
    });


    // Lấy thông tin sender để bắn Realtime/Tracing
    let senderProfile = null;
    try {
      const USERORG_URL = process.env.USERORG_SERVICE_URL || 'http://localhost:3011';
      // Gọi fetch batch id có 1 user
      const response = await fetch(`${USERORG_URL}/users/batch?ids=${senderId}`);
      if (response.ok) {
        const data = (await response.json()) as any;
        if (data && data.users && data.users.length > 0) {
          senderProfile = data.users[0];
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch user profile for new message');
    }

    const senderPayload = senderProfile ? {
      id: senderProfile.id,
      name: senderProfile.name,
      avatar: senderProfile.avatar,
    } : undefined;

    // Process mentions
    const mentions = await mentionService.processMentions(
      message.id,
      message.content || '',
      chatId,
      senderId
    );

    // Trigger AI response if @AI is mentioned
    const aiMentioned = mentions.some(m => m.targetType === 'AI');
    if (aiMentioned) {
      await publishEvent('ai.request', {
        messageId: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        content: message.content?.replace(/@AI/gi, '').trim(),
      });
    }

    // Publish event for realtime
    await publishEvent(EventSubjects.MESSAGE_CREATED, {
      id: message.id,
      chatId: message.chatId,
      senderId: message.senderId,
      sender: senderPayload,
      content: message.content,
      type: message.type,
      time: message.time.toISOString(),
      replyTo: message.replyTo,
      file: fileName ? { name: fileName, size: fileSize, type: fileType } : null,
      reactions: [],
      pin: false,
    });


    logger.info({ messageId: message.id, chatId }, 'Message sent');

    return {
      ...message,
      sender: senderPayload,
    };
  }

  /**
   * Xóa tin nhắn (cho mình)
   */
  async deleteMessageForMe(messageId: string, userId: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new Error('Không tìm thấy tin nhắn!');
    }

    // Add userId to deletedBy array
    let deletedBy: string[] = [];
    try {
      deletedBy = message.deletedBy ? JSON.parse(message.deletedBy) : [];
    } catch {
      deletedBy = [];
    }

    if (!deletedBy.includes(userId)) {
      deletedBy.push(userId);
    }

    await prisma.message.update({
      where: { id: messageId },
      data: { deletedBy: JSON.stringify(deletedBy) },
    });

    logger.info({ messageId, userId }, 'Message deleted for user');
  }

  /**
   * Thu hồi tin nhắn (xóa cho tất cả)
   */
  async recallMessage(messageId: string, userId: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new Error('Không tìm thấy tin nhắn!');
    }

    if (message.senderId !== userId) {
      throw new Error('Chỉ người gửi mới có thể thu hồi!');
    }

    // Check time limit (24h)
    const timeDiff = Date.now() - new Date(message.time).getTime();
    if (timeDiff > 24 * 60 * 60 * 1000) {
      throw new Error('Chỉ có thể thu hồi tin nhắn trong 24 giờ!');
    }

    await prisma.message.update({
      where: { id: messageId },
      data: { destroy: true, content: null },
    });

    // Publish event
    await publishEvent(EventSubjects.MESSAGE_DELETED, {
      id: messageId,
      chatId: message.chatId,
      recalledBy: userId,
    });

    logger.info({ messageId }, 'Message recalled');
  }

  /**
   * React tin nhắn
   */
  async reactMessage(messageId: string, userId: string, emoji: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new Error('Không tìm thấy tin nhắn!');
    }

    // Check existing reaction
    const existingReaction = await prisma.reaction.findFirst({
      where: { messageId, userId },
    });

    let action: 'added' | 'changed' | 'removed';

    if (existingReaction) {
      if (existingReaction.reaction === emoji) {
        // Remove reaction
        await prisma.reaction.delete({ where: { id: existingReaction.id } });
        action = 'removed';
      } else {
        // Change reaction
        await prisma.reaction.update({
          where: { id: existingReaction.id },
          data: { reaction: emoji },
        });
        action = 'changed';
      }
    } else {
      // Add new reaction
      await prisma.reaction.create({
        data: {
          id: uuidv4(),
          messageId,
          userId,
          reaction: emoji,
        },
      });
      action = 'added';
    }

    // Publish event
    await publishEvent(EventSubjects.MESSAGE_REACTION, {
      messageId,
      chatId: message.chatId,
      userId,
      emoji,
      action,
    });

    return { action, emoji };
  }

  /**
   * Ghim/bỏ ghim tin nhắn
   */
  async togglePinMessage(messageId: string, userId: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new Error('Không tìm thấy tin nhắn!');
    }

    const newPinState = !message.pin;

    await prisma.message.update({
      where: { id: messageId },
      data: { pin: newPinState },
    });

    logger.info({ messageId, pin: newPinState }, 'Message pin toggled');

    return { pin: newPinState };
  }

  /**
   * Lấy tin nhắn đã ghim
   */
  async getPinnedMessages(chatId: string) {
    const messages = await prisma.message.findMany({
      where: { chatId, pin: true, destroy: false },
      orderBy: { time: 'desc' },
    });
    return this.populateSenderInfo(messages);
  }

  /**
   * Tìm kiếm tin nhắn
   */
  async searchMessages(chatId: string, query: string) {
    if (!query || query.trim().length < 1) {
      throw new Error('Từ khóa phải có ít nhất 1 ký tự!');
    }

    const messages = await prisma.message.findMany({
      where: {
        chatId,
        destroy: false,
        content: { contains: query, mode: 'insensitive' },
        type: 'text',
      },
      orderBy: { time: 'desc' },
      take: 50,
    });
    return this.populateSenderInfo(messages);
  }

  /**
   * Lấy media files trong chat
   */
  async getMediaMessages(chatId: string, type?: string) {
    let typeFilter: string[] = [];
    if (type === 'image') typeFilter = ['image'];
    else if (type === 'video') typeFilter = ['video'];
    else if (type === 'file') typeFilter = ['file', 'audio'];
    else typeFilter = ['image', 'video', 'file', 'audio'];

    const messages = await prisma.message.findMany({
      where: {
        chatId,
        destroy: false,
        type: { in: typeFilter },
      },
      orderBy: { time: 'desc' },
      take: 100,
    });
    return this.populateSenderInfo(messages);
  }

  /**
   * Group reactions by emoji
   */
  private groupReactions(reactions: any[]) {
    return reactions.reduce((acc: any[], r) => {
      const existing = acc.find((a) => a.emoji === r.reaction);
      if (existing) {
        existing.count += 1;
        existing.userIds.push(r.userId);
      } else {
        acc.push({
          emoji: r.reaction,
          count: 1,
          userIds: [r.userId],
        });
      }
      return acc;
    }, []);
  }

  /**
   * Helper function: lấy thông tin Profile User gắn vào array message
   */
  private async populateSenderInfo(messages: any[]) {
    if (!messages || messages.length === 0) return messages;

    const uniqueAccountIds = [...new Set(messages.map((m) => m.senderId))];
    const accountMap = new Map<string, any>();

    if (uniqueAccountIds.length > 0) {
      try {
        const USERORG_URL = process.env.USERORG_SERVICE_URL || 'http://localhost:3011';
        const response = await fetch(`${USERORG_URL}/users/batch?ids=${uniqueAccountIds.join(',')}`);
        if (response.ok) {
          const data = (await response.json()) as any;
          if (data && data.users) {
            data.users.forEach((u: any) => accountMap.set(u.id, u));
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to fetch user profiles for messages');
      }
    }

    return messages.map((msg) => {
      const senderAcc = accountMap.get(msg.senderId);
      return {
        ...msg,
        sender: senderAcc ? {
          id: senderAcc.id,
          name: senderAcc.name,
          avatar: senderAcc.avatar,
        } : undefined,
      };
    });
  }

  /**
   * Lấy tóm tắt cho danh sách chat (last message + unread count)
   * Phục vụ cho sidebar ở frontend
   */
  async getChatSummary(userId: string, chatIds: string[]) {
    const summary = await Promise.all(
      chatIds.map(async (chatId) => {
        // 1. Lấy tin nhắn cuối cùng
        const lastMessage = await prisma.message.findFirst({
          where: { chatId, destroy: false },
          orderBy: { time: 'desc' },
          include: {
            reactions: true,
          }
        });

        // 2. Lấy unread count
        // Tìm read receipt của user này cho chat này
        const readReceipt = await prisma.readReceipt.findUnique({
          where: { chatId_userId: { chatId, userId } }
        });

        let unreadCount = 0;
        if (readReceipt) {
          // Lấy tin nhắn receipt trỏ tới (để lấy thời gian)
          const lastReadMsg = await prisma.message.findUnique({
            where: { id: readReceipt.messageId }
          });

          if (lastReadMsg) {
            unreadCount = await prisma.message.count({
              where: {
                chatId,
                destroy: false,
                senderId: { not: userId },
                time: { gt: lastReadMsg.time }
              }
            });
          }
        } else {
          // Nếu chưa có receipt, đếm tất cả tin nhắn không phải của mình
          unreadCount = await prisma.message.count({
            where: {
              chatId,
              destroy: false,
              senderId: { not: userId }
            }
          });
        }

        // 3. Hydrate thông tin sender cho last message
        let sender = null;
        if (lastMessage) {
          const profiles = await this.populateSenderInfo([lastMessage]);
          sender = profiles[0].sender;
        }

        // 4. Định dạng nội dung hiển thị (nếu là file/hình ảnh thì hiện [Hình ảnh], [File]...)
        let displayContent = lastMessage?.content;
        if (lastMessage && !displayContent) {
          switch (lastMessage.type) {
            case 'image': displayContent = '[Hình ảnh]'; break;
            case 'video': displayContent = '[Video]'; break;
            case 'audio': displayContent = '[Âm thanh]'; break;
            case 'file': displayContent = `[Tệp tin: ${lastMessage.fileName || 'Không tên'}]`; break;
            case 'call_ended': displayContent = '[Cuộc gọi đã kết thúc]'; break;
            case 'call_missed': displayContent = '[Cuộc gọi nhỡ]'; break;
            case 'system': displayContent = '[Thông báo hệ thống]'; break;
            default: displayContent = '[Tin nhắn mới]';
          }
        }

        return {
          chatId,
          lastMessage: lastMessage ? {
            id: lastMessage.id,
            content: displayContent,
            type: lastMessage.type,
            time: lastMessage.time,
            sender: sender || { id: lastMessage.senderId, name: 'Người dùng' }
          } : null,
          unreadCount
        };
      })
    );

    return summary;
  }
}

export const messageService = new MessageService();
