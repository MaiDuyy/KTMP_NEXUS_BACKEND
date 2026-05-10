// tests/routes/mention.routes.test.ts
// Integration tests for Mention API endpoints

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../setup/app.js';

// Mock dependencies
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    mention: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../../src/lib/nats.js', () => ({
  publishEvent: vi.fn(),
  EventSubjects: {},
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { prisma } from '../../src/lib/prisma.js';

describe('Mention Routes', () => {
  const app = createTestApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /mentions', () => {
    it('should return 401 without auth', async () => {
      const response = await request(app).get('/mentions');
      expect(response.status).toBe(401);
    });

    it('should return user mentions', async () => {
      const mockMentions = [
        {
          id: 'mention-1',
          messageId: 'msg-1',
          createdAt: new Date(),
          message: {
            id: 'msg-1',
            chatId: 'chat-1',
            senderId: 'sender-1',
            content: '@you hello',
            time: new Date(),
          },
        },
      ];

      vi.mocked(prisma.mention.findMany).mockResolvedValue(mockMentions as any);

      const response = await request(app)
        .get('/mentions')
        .set('x-user-id', 'user-123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.mentions).toHaveLength(1);
    });

    it('should support pagination with cursor', async () => {
      vi.mocked(prisma.mention.findMany).mockResolvedValue([]);

      const response = await request(app)
        .get('/mentions?cursor=2026-01-01T00:00:00Z&limit=10')
        .set('x-user-id', 'user-123');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /mentions/unread-count', () => {
    it('should return unread count', async () => {
      vi.mocked(prisma.mention.count).mockResolvedValue(5);

      const response = await request(app)
        .get('/mentions/unread-count')
        .set('x-user-id', 'user-123');

      expect(response.status).toBe(200);
      expect(response.body.unreadCount).toBe(5);
    });

    it('should support since parameter', async () => {
      vi.mocked(prisma.mention.count).mockResolvedValue(2);

      const response = await request(app)
        .get('/mentions/unread-count?since=2026-01-01T00:00:00Z')
        .set('x-user-id', 'user-123');

      expect(response.status).toBe(200);
      expect(response.body.unreadCount).toBe(2);
    });
  });
});
