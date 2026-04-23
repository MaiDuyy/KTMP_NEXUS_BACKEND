// services/chat-service/src/services/readreceipt.service.ts
// Read Receipt System for MSG-12: Read Receipts

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export class ReadReceiptService {
  /**
   * Mark messages as read up to a specific message
   */
  async markAsRead(chatId: string, userId: string, messageId?: string) {
    console.log(`[ReadReceiptService] markAsRead called for chat: ${chatId}, user: ${userId}, msg: ${messageId || 'LATEST'}`);
    let finalMessageId = messageId;
    let readAt: Date;

    if (!finalMessageId) {
      // Find the latest message in the chat
      const latestMsg = await prisma.message.findFirst({
        where: { chatId, destroy: false },
        orderBy: { time: 'desc' },
      });
      
      if (!latestMsg) {
        console.warn(`[ReadReceiptService] No messages found for chat ${chatId} to mark as read`);
        return null;
      }
      finalMessageId = latestMsg.id;
      readAt = latestMsg.time;
      console.log(`[ReadReceiptService] Auto-selected latest message: ${finalMessageId} at ${readAt}`);
    } else {
      // Verify the message exists and belongs to the chat
      const message = await prisma.message.findFirst({
        where: { id: finalMessageId, chatId },
      });

      if (!message) {
        throw new Error('Message not found in this chat!');
      }
      readAt = message.time;
    }

    // Upsert read receipt (user can only have one per chat)
    const receipt = await prisma.readReceipt.upsert({
      where: {
        chatId_userId: { chatId, userId },
      },
      update: {
        messageId: finalMessageId,
        readAt: readAt,
      },
      create: {
        id: uuidv4(),
        chatId,
        userId,
        messageId: finalMessageId,
        readAt: readAt,
      },
    });

    // Publish event for realtime update
    await publishEvent(EventSubjects.MESSAGE_READ || 'message.read', {
      chatId,
      userId,
      messageId: finalMessageId,
      readAt: receipt.readAt.toISOString(),
    });

    logger.info({ chatId, userId, messageId }, 'Message marked as read');

    return receipt;
  }

  /**
   * Get read receipts for a chat (who has read what)
   */
  async getReadReceipts(chatId: string) {
    const receipts = await prisma.readReceipt.findMany({
      where: { chatId },
      orderBy: { readAt: 'desc' },
    });

    return receipts.map((r) => ({
      userId: r.userId,
      messageId: r.messageId,
      readAt: r.readAt,
    }));
  }

  /**
   * Get last read message for a user in a chat
   */
  async getLastReadMessage(chatId: string, userId: string) {
    const receipt = await prisma.readReceipt.findUnique({
      where: {
        chatId_userId: { chatId, userId },
      },
    });

    return receipt
      ? { messageId: receipt.messageId, readAt: receipt.readAt }
      : null;
  }

  /**
   * Get unread count for a user in a chat
   */
  async getUnreadCount(chatId: string, userId: string) {
    const lastRead = await this.getLastReadMessage(chatId, userId);

    const whereCondition: any = {
      chatId,
      destroy: false,
      senderId: { not: userId }, // Don't count own messages
    };

    if (lastRead) {
      whereCondition.time = { gt: lastRead.readAt };
    }

    return prisma.message.count({ where: whereCondition });
  }

  /**
   * Get unread counts for multiple chats
   */
  async getBatchUnreadCounts(chatIds: string[], userId: string) {
    const results: Record<string, number> = {};

    // Get all read receipts for this user
    const receipts = await prisma.readReceipt.findMany({
      where: {
        chatId: { in: chatIds },
        userId,
      },
    });

    const receiptMap = new Map(receipts.map((r) => [r.chatId, r]));

    // Count unread for each chat
    await Promise.all(
      chatIds.map(async (chatId) => {
        const receipt = receiptMap.get(chatId);

        const whereCondition: any = {
          chatId,
          destroy: false,
          senderId: { not: userId },
        };

        if (receipt) {
          whereCondition.time = { gt: receipt.readAt };
        }

        const count = await prisma.message.count({ where: whereCondition });
        results[chatId] = count;
      })
    );

    return results;
  }
}

export const readReceiptService = new ReadReceiptService();
