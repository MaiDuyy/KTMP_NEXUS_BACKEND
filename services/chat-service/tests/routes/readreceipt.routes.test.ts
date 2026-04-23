// tests/routes/readreceipt.routes.test.ts
// Integration tests for Read Receipt API endpoints

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../setup/app.js';

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
  EventSubjects: { MESSAGE_READ: 'message.read' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'receipt-uuid') }));

import { prisma } from '../../src/lib/prisma.js';

describe('ReadReceipt Routes', () => {
  const app = createTestApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /chats/:chatId/read', () => {
    it('should return 401 without auth', async () => {
      const response = await request(app)
        .post('/chats/chat-123/read')
        .send({ messageId: 'msg-1' });

      expect(response.status).toBe(401);
    });

    it('should return 400 without messageId', async () => {
      const response = await request(app)
        .post('/chats/chat-123/read')
        .set('x-user-id', 'user-123')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should mark message as read', async () => {
      const receipt = {
        id: 'receipt-uuid',
        chatId: 'chat-123',
        userId: 'user-123',
        messageId: 'msg-1',
        readAt: new Date(),
      };

      vi.mocked(prisma.message.findFirst).mockResolvedValue({ id: 'msg-1', chatId: 'chat-123' } as any);
      vi.mocked(prisma.readReceipt.upsert).mockResolvedValue(receipt as any);

      const response = await request(app)
        .post('/chats/chat-123/read')
        .set('x-user-id', 'user-123')
        .send({ messageId: 'msg-1' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.receipt.messageId).toBe('msg-1');
    });
  });

  describe('GET /chats/:chatId/receipts', () => {
    it('should return read receipts', async () => {
      const receipts = [
        { userId: 'user-1', messageId: 'msg-100', readAt: new Date() },
      ];

      vi.mocked(prisma.readReceipt.findMany).mockResolvedValue(receipts as any);

      const response = await request(app)
        .get('/chats/chat-123/receipts')
        .set('x-user-id', 'user-123');

      expect(response.status).toBe(200);
      expect(response.body.receipts).toHaveLength(1);
    });
  });

  describe('GET /chats/:chatId/unread-count', () => {
    it('should return unread count', async () => {
      vi.mocked(prisma.readReceipt.findUnique).mockResolvedValue({
        messageId: 'msg-50',
        readAt: new Date(),
      } as any);
      vi.mocked(prisma.message.count).mockResolvedValue(10);

      const response = await request(app)
        .get('/chats/chat-123/unread-count')
        .set('x-user-id', 'user-123');

      expect(response.status).toBe(200);
      expect(response.body.unreadCount).toBe(10);
    });
  });

  describe('POST /chats/batch-unread', () => {
    it('should return 400 without chatIds', async () => {
      const response = await request(app)
        .post('/chats/batch-unread')
        .set('x-user-id', 'user-123')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return batch unread counts', async () => {
      vi.mocked(prisma.readReceipt.findMany).mockResolvedValue([]);
      vi.mocked(prisma.message.count).mockResolvedValue(5);

      const response = await request(app)
        .post('/chats/batch-unread')
        .set('x-user-id', 'user-123')
        .send({ chatIds: ['chat-1', 'chat-2'] });

      expect(response.status).toBe(200);
      expect(response.body.unreadCounts).toBeDefined();
    });
  });
});
