// tests/routes/thread.routes.test.ts
// Integration tests for Thread API endpoints

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../setup/app.js';

// Mock all dependencies
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
  EventSubjects: { THREAD_REPLY_CREATED: 'thread.reply.created' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid-1234') }));

import { prisma } from '../../src/lib/prisma.js';

describe('Thread Routes', () => {
  const app = createTestApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /threads/:parentId', () => {
    it('should return 401 when x-user-id header is missing', async () => {
      const response = await request(app)
        .post('/threads/parent-123')
        .send({ content: 'Test reply' });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when content is empty', async () => {
      const response = await request(app)
        .post('/threads/parent-123')
        .set('x-user-id', 'user-123')
        .send({ content: '' });

      expect(response.status).toBe(400);
    });

    it('should create thread reply successfully', async () => {
      const parentMessage = {
        id: 'parent-123',
        chatId: 'chat-456',
        rootThreadId: null,
        destroy: false,
      };

      const createdReply = {
        id: 'test-uuid-1234',
        chatId: 'chat-456',
        senderId: 'user-789',
        content: 'Test reply',
        type: 'text',
        parentId: 'parent-123',
        rootThreadId: 'parent-123',
        time: new Date(),
        fileName: null,
        fileSize: null,
        fileType: null,
      };

      vi.mocked(prisma.message.findUnique).mockResolvedValue(parentMessage as any);
      vi.mocked(prisma.message.create).mockResolvedValue(createdReply as any);
      vi.mocked(prisma.message.update).mockResolvedValue({ replyCount: 1 } as any);

      const response = await request(app)
        .post('/threads/parent-123')
        .set('x-user-id', 'user-789')
        .send({ content: 'Test reply' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.reply.content).toBe('Test reply');
    });
  });

  describe('GET /threads/:parentId', () => {
    it('should return 401 without auth', async () => {
      const response = await request(app).get('/threads/parent-123');
      expect(response.status).toBe(401);
    });

    it('should return thread replies', async () => {
      const parentMessage = { id: 'parent-123', chatId: 'chat-456', replyCount: 2 };
      const replies = [
        { id: 'reply-1', content: 'Reply 1', time: new Date(), senderId: 'user-1', parentId: 'parent-123', reactions: [] },
      ];

      vi.mocked(prisma.message.findUnique).mockResolvedValue(parentMessage as any);
      vi.mocked(prisma.message.findMany).mockResolvedValue(replies as any);

      const response = await request(app)
        .get('/threads/parent-123')
        .set('x-user-id', 'user-123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.replies).toBeDefined();
    });
  });

  describe('GET /threads/:parentId/preview', () => {
    it('should return thread preview', async () => {
      vi.mocked(prisma.message.findUnique).mockResolvedValue({ id: 'parent-123', replyCount: 5 } as any);
      vi.mocked(prisma.message.findMany).mockResolvedValue([]);

      const response = await request(app)
        .get('/threads/parent-123/preview')
        .set('x-user-id', 'user-123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});
