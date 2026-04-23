// tests/services/readreceipt.service.test.ts
// Unit tests for ReadReceiptService

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    message: {
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    readReceipt: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../src/lib/nats.js', () => ({
  publishEvent: vi.fn(),
  EventSubjects: {
    MESSAGE_READ: 'message.read',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'receipt-uuid-1234'),
}));

import { prisma } from '../../src/lib/prisma.js';
import { publishEvent } from '../../src/lib/nats.js';
import { ReadReceiptService } from '../../src/services/readreceipt.service.js';

describe('ReadReceiptService', () => {
  let readReceiptService: ReadReceiptService;

  beforeEach(() => {
    readReceiptService = new ReadReceiptService();
    vi.clearAllMocks();
  });

  describe('markAsRead', () => {
    it('should mark message as read and publish event', async () => {
      // Arrange
      const message = { id: 'msg-123', chatId: 'chat-456' };
      const receipt = {
        id: 'receipt-uuid-1234',
        chatId: 'chat-456',
        userId: 'user-789',
        messageId: 'msg-123',
        readAt: new Date('2026-01-28T12:00:00Z'),
      };

      vi.mocked(prisma.message.findFirst).mockResolvedValue(message as any);
      vi.mocked(prisma.readReceipt.upsert).mockResolvedValue(receipt as any);

      // Act
      const result = await readReceiptService.markAsRead('chat-456', 'user-789', 'msg-123');

      // Assert
      expect(result.messageId).toBe('msg-123');
      expect(prisma.readReceipt.upsert).toHaveBeenCalledWith({
        where: { chatId_userId: { chatId: 'chat-456', userId: 'user-789' } },
        update: { messageId: 'msg-123', readAt: expect.any(Date) },
        create: {
          id: 'receipt-uuid-1234',
          chatId: 'chat-456',
          userId: 'user-789',
          messageId: 'msg-123',
        },
      });
      expect(publishEvent).toHaveBeenCalled();
    });

    it('should throw error when message not in chat', async () => {
      vi.mocked(prisma.message.findFirst).mockResolvedValue(null);

      await expect(
        readReceiptService.markAsRead('chat-456', 'user-789', 'invalid-msg')
      ).rejects.toThrow('Message not found in this chat!');
    });
  });

  describe('getReadReceipts', () => {
    it('should return all read receipts for chat', async () => {
      const receipts = [
        { userId: 'user-1', messageId: 'msg-100', readAt: new Date() },
        { userId: 'user-2', messageId: 'msg-99', readAt: new Date() },
      ];

      vi.mocked(prisma.readReceipt.findMany).mockResolvedValue(receipts as any);

      const result = await readReceiptService.getReadReceipts('chat-456');

      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe('user-1');
    });
  });

  describe('getLastReadMessage', () => {
    it('should return last read message for user', async () => {
      const receipt = {
        messageId: 'msg-123',
        readAt: new Date('2026-01-28T12:00:00Z'),
      };

      vi.mocked(prisma.readReceipt.findUnique).mockResolvedValue(receipt as any);

      const result = await readReceiptService.getLastReadMessage('chat-456', 'user-789');

      expect(result?.messageId).toBe('msg-123');
    });

    it('should return null when no read receipt', async () => {
      vi.mocked(prisma.readReceipt.findUnique).mockResolvedValue(null);

      const result = await readReceiptService.getLastReadMessage('chat-456', 'user-789');
      expect(result).toBeNull();
    });
  });

  describe('getUnreadCount', () => {
    it('should return unread message count', async () => {
      vi.mocked(prisma.readReceipt.findUnique).mockResolvedValue({
        messageId: 'msg-100',
        readAt: new Date('2026-01-28T10:00:00Z'),
      } as any);
      vi.mocked(prisma.message.count).mockResolvedValue(5);

      const count = await readReceiptService.getUnreadCount('chat-456', 'user-789');

      expect(count).toBe(5);
      expect(prisma.message.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          chatId: 'chat-456',
          destroy: false,
          senderId: { not: 'user-789' },
        }),
      });
    });

    it('should count all messages when no read receipt', async () => {
      vi.mocked(prisma.readReceipt.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.message.count).mockResolvedValue(20);

      const count = await readReceiptService.getUnreadCount('chat-456', 'user-789');
      expect(count).toBe(20);
    });
  });
});
