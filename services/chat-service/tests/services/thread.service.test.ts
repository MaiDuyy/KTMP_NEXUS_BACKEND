// tests/services/thread.service.test.ts
// Unit tests for ThreadService

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the service
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    message: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../src/lib/nats.js', () => ({
  publishEvent: vi.fn(),
  EventSubjects: {
    THREAD_REPLY_CREATED: 'thread.reply.created',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mocked-uuid-1234'),
}));

import { prisma } from '../../src/lib/prisma.js';
import { publishEvent } from '../../src/lib/nats.js';
import { ThreadService } from '../../src/services/thread.service.js';

describe('ThreadService', () => {
  let threadService: ThreadService;

  beforeEach(() => {
    threadService = new ThreadService();
    vi.clearAllMocks();
  });

  describe('createThreadReply', () => {
    it('should create a thread reply for valid parent', async () => {
      // Arrange
      const parentMessage = {
        id: 'parent-123',
        chatId: 'chat-456',
        rootThreadId: null,
        destroy: false,
      };

      const createdReply = {
        id: 'mocked-uuid-1234',
        chatId: 'chat-456',
        senderId: 'user-789',
        content: 'Test reply',
        type: 'text',
        parentId: 'parent-123',
        rootThreadId: 'parent-123',
        time: new Date('2026-01-28T12:00:00Z'),
        fileName: null,
        fileSize: null,
        fileType: null,
      };

      vi.mocked(prisma.message.findUnique).mockResolvedValue(parentMessage as any);
      vi.mocked(prisma.message.create).mockResolvedValue(createdReply as any);
      vi.mocked(prisma.message.update).mockResolvedValue({ replyCount: 1 } as any);

      // Act
      const result = await threadService.createThreadReply(
        'parent-123',
        'user-789',
        { content: 'Test reply' }
      );

      // Assert
      expect(result.id).toBe('mocked-uuid-1234');
      expect(result.parentId).toBe('parent-123');
      expect(prisma.message.create).toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'parent-123' },
        data: { replyCount: { increment: 1 } },
      });
      expect(publishEvent).toHaveBeenCalled();
    });

    it('should throw error when parent message not found', async () => {
      // Arrange
      vi.mocked(prisma.message.findUnique).mockResolvedValue(null);

      // Act & Assert
      await expect(
        threadService.createThreadReply('invalid-id', 'user-123', { content: 'Test' })
      ).rejects.toThrow('Parent message not found!');
    });

    it('should throw error when parent message is destroyed', async () => {
      // Arrange
      vi.mocked(prisma.message.findUnique).mockResolvedValue({
        id: 'parent-123',
        destroy: true,
      } as any);

      // Act & Assert
      await expect(
        threadService.createThreadReply('parent-123', 'user-123', { content: 'Test' })
      ).rejects.toThrow('Cannot reply to a deleted message!');
    });
  });

  describe('getThreadReplies', () => {
    it('should return paginated thread replies', async () => {
      // Arrange
      const parentMessage = { id: 'parent-123', chatId: 'chat-456', replyCount: 5 };
      const replies = [
        { id: 'reply-1', content: 'Reply 1', time: new Date(), senderId: 'user-1', parentId: 'parent-123', reactions: [] },
        { id: 'reply-2', content: 'Reply 2', time: new Date(), senderId: 'user-2', parentId: 'parent-123', reactions: [] },
      ];

      vi.mocked(prisma.message.findUnique).mockResolvedValue(parentMessage as any);
      vi.mocked(prisma.message.findMany).mockResolvedValue(replies as any);

      // Act
      const result = await threadService.getThreadReplies('parent-123', { limit: 10 });

      // Assert
      expect(result.parentId).toBe('parent-123');
      expect(result.chatId).toBe('chat-456');
      expect(result.totalReplies).toBe(5);
      expect(result.replies).toHaveLength(2);
    });

    it('should throw error when parent not found', async () => {
      vi.mocked(prisma.message.findUnique).mockResolvedValue(null);

      await expect(
        threadService.getThreadReplies('invalid-id')
      ).rejects.toThrow('Parent message not found!');
    });
  });

  describe('getThreadPreview', () => {
    it('should return preview with latest 3 replies', async () => {
      // Arrange
      const parentMessage = { id: 'parent-123', replyCount: 10 };
      const latestReplies = [
        { id: 'reply-3', senderId: 'user-3', content: 'Latest 3', time: new Date() },
        { id: 'reply-2', senderId: 'user-2', content: 'Latest 2', time: new Date() },
        { id: 'reply-1', senderId: 'user-1', content: 'Latest 1', time: new Date() },
      ];

      vi.mocked(prisma.message.findUnique).mockResolvedValue(parentMessage as any);
      vi.mocked(prisma.message.findMany).mockResolvedValue(latestReplies as any);

      // Act
      const result = await threadService.getThreadPreview('parent-123');

      // Assert
      expect(result?.parentId).toBe('parent-123');
      expect(result?.replyCount).toBe(10);
      expect(result?.latestReplies).toHaveLength(3);
    });

    it('should return null when parent not found', async () => {
      vi.mocked(prisma.message.findUnique).mockResolvedValue(null);

      const result = await threadService.getThreadPreview('invalid-id');
      expect(result).toBeNull();
    });
  });
});
