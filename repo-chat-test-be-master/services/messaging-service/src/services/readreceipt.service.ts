// services/messaging-service/src/services/readreceipt.service.ts
// Read Receipt System — migrated from chat-service (no changes needed)

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export class ReadReceiptService {
  async markAsRead(chatId: string, userId: string, messageId?: string) {
    let finalMessageId = messageId;
    let readAt: Date;

    if (!finalMessageId) {
      const latestMsg = await prisma.message.findFirst({
        where: { chatId, destroy: false }, orderBy: { time: 'desc' },
      });
      if (!latestMsg) return null;
      finalMessageId = latestMsg.id;
      readAt = latestMsg.time;
    } else {
      const message = await prisma.message.findFirst({ where: { id: finalMessageId, chatId } });
      if (!message) throw new Error('Message not found in this chat!');
      readAt = message.time;
    }

    const receipt = await prisma.readReceipt.upsert({
      where: { chatId_userId: { chatId, userId } },
      update: { messageId: finalMessageId, readAt },
      create: { id: uuidv4(), chatId, userId, messageId: finalMessageId, readAt },
    });

    await publishEvent(EventSubjects.MESSAGE_READ, {
      chatId, userId, messageId: finalMessageId, readAt: receipt.readAt.toISOString(),
    });

    logger.info({ chatId, userId, messageId }, 'Message marked as read');
    return receipt;
  }

  async getReadReceipts(chatId: string) {
    const receipts = await prisma.readReceipt.findMany({ where: { chatId }, orderBy: { readAt: 'desc' } });
    return receipts.map((r) => ({ userId: r.userId, messageId: r.messageId, readAt: r.readAt }));
  }

  async getLastReadMessage(chatId: string, userId: string) {
    const receipt = await prisma.readReceipt.findUnique({ where: { chatId_userId: { chatId, userId } } });
    return receipt ? { messageId: receipt.messageId, readAt: receipt.readAt } : null;
  }

  async getUnreadCount(chatId: string, userId: string) {
    const lastRead = await this.getLastReadMessage(chatId, userId);
    const whereCondition: any = { chatId, destroy: false, senderId: { not: userId } };
    if (lastRead) whereCondition.time = { gt: lastRead.readAt };
    return prisma.message.count({ where: whereCondition });
  }

  async getBatchUnreadCounts(chatIds: string[], userId: string) {
    const results: Record<string, number> = {};
    const receipts = await prisma.readReceipt.findMany({ where: { chatId: { in: chatIds }, userId } });
    const receiptMap = new Map(receipts.map((r) => [r.chatId, r]));

    await Promise.all(
      chatIds.map(async (chatId) => {
        const receipt = receiptMap.get(chatId);
        const whereCondition: any = { chatId, destroy: false, senderId: { not: userId } };
        if (receipt) whereCondition.time = { gt: receipt.readAt };
        results[chatId] = await prisma.message.count({ where: whereCondition });
      })
    );
    return results;
  }
}

export const readReceiptService = new ReadReceiptService();
