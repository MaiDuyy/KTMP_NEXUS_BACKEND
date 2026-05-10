// tests/services/mention.service.test.ts
// Unit tests for MentionService

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    mention: {
      create: vi.fn(),
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
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mention-uuid-1234'),
}));

import { MentionService } from '../../src/services/mention.service.js';

describe('MentionService', () => {
  let mentionService: MentionService;

  beforeEach(() => {
    mentionService = new MentionService();
    vi.clearAllMocks();
  });

  describe('extractMentions', () => {
    it('should extract @[User Name](userId) format mentions', () => {
      const content = 'Hello @[John Doe](user-123) how are you?';
      const mentions = mentionService.extractMentions(content);

      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toEqual({
        type: 'USER',
        targetId: 'user-123',
        raw: '@[John Doe](user-123)',
      });
    });

    it('should extract multiple user mentions', () => {
      const content = '@[Alice](user-1) and @[Bob](user-2) are here';
      const mentions = mentionService.extractMentions(content);

      expect(mentions).toHaveLength(2);
      expect(mentions[0].targetId).toBe('user-1');
      expect(mentions[1].targetId).toBe('user-2');
    });

    it('should extract @here mention', () => {
      const content = 'Hey @here please check this';
      const mentions = mentionService.extractMentions(content);

      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toEqual({
        type: 'HERE',
        raw: '@here',
      });
    });

    it('should extract @channel mention', () => {
      const content = 'Important @channel announcement';
      const mentions = mentionService.extractMentions(content);

      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toEqual({
        type: 'CHANNEL',
        raw: '@channel',
      });
    });

    it('should extract mixed mentions', () => {
      const content = '@[Admin](user-admin) and @here plus @channel';
      const mentions = mentionService.extractMentions(content);

      expect(mentions).toHaveLength(3);
      expect(mentions.map(m => m.type)).toEqual(['USER', 'HERE', 'CHANNEL']);
    });

    it('should return empty array when no mentions', () => {
      const content = 'Just a regular message';
      const mentions = mentionService.extractMentions(content);

      expect(mentions).toHaveLength(0);
    });

    it('should handle empty or null content', () => {
      expect(mentionService.extractMentions('')).toHaveLength(0);
      expect(mentionService.extractMentions(null as any)).toHaveLength(0);
    });
  });

  describe('getMentionsForUser', () => {
    it('should return paginated mentions for user', async () => {
      const { prisma } = await import('../../src/lib/prisma.js');
      
      const mockMentions = [
        {
          id: 'mention-1',
          messageId: 'msg-1',
          createdAt: new Date('2026-01-28T10:00:00Z'),
          message: {
            id: 'msg-1',
            chatId: 'chat-1',
            senderId: 'sender-1',
            content: 'Hello @you',
            time: new Date('2026-01-28T10:00:00Z'),
          },
        },
      ];

      vi.mocked(prisma.mention.findMany).mockResolvedValue(mockMentions as any);

      const result = await mentionService.getMentionsForUser('user-123', { limit: 20 });

      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].messageId).toBe('msg-1');
    });
  });

  describe('getUnreadMentionCount', () => {
    it('should return unread mention count', async () => {
      const { prisma } = await import('../../src/lib/prisma.js');
      
      vi.mocked(prisma.mention.count).mockResolvedValue(5);

      const count = await mentionService.getUnreadMentionCount('user-123');
      expect(count).toBe(5);
    });

    it('should filter by lastSeenAt', async () => {
      const { prisma } = await import('../../src/lib/prisma.js');
      const lastSeenAt = new Date('2026-01-28T08:00:00Z');

      vi.mocked(prisma.mention.count).mockResolvedValue(2);

      const count = await mentionService.getUnreadMentionCount('user-123', lastSeenAt);
      
      expect(count).toBe(2);
      expect(prisma.mention.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          createdAt: { gt: lastSeenAt },
        }),
      });
    });
  });
});
