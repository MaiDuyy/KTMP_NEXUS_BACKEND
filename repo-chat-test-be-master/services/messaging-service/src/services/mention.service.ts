// services/messaging-service/src/services/mention.service.ts
// Mention System — migrated from chat-service (no changes needed)

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export type MentionTargetType = 'USER' | 'HERE' | 'CHANNEL' | 'AI';

export interface ParsedMention {
  type: MentionTargetType;
  targetId?: string;
  raw: string;
}

export class MentionService {
  extractMentions(content: string): ParsedMention[] {
    const mentions: ParsedMention[] = [];
    if (!content) return mentions;

    const userMentionRegex = /@\[([^\]]+)\]\(([a-zA-Z0-9_-]+)\)/g;
    let match;
    while ((match = userMentionRegex.exec(content)) !== null) {
      mentions.push({ type: 'USER', targetId: match[2], raw: match[0] });
    }

    if (/@here\b/i.test(content)) mentions.push({ type: 'HERE', raw: '@here' });
    if (/@channel\b/i.test(content)) mentions.push({ type: 'CHANNEL', raw: '@channel' });
    if (/@AI\b/i.test(content)) mentions.push({ type: 'AI', raw: '@AI' });

    return mentions;
  }

  async processMentions(messageId: string, content: string, chatId: string, senderId: string) {
    const parsedMentions = this.extractMentions(content);
    if (parsedMentions.length === 0) return [];

    const mentionRecords = await Promise.all(
      parsedMentions.map(async (mention) => {
        const record = await prisma.mention.create({
          data: { id: uuidv4(), messageId, targetType: mention.type, targetId: mention.targetId || null },
        });
        return { ...record, raw: mention.raw };
      })
    );

    const userMentions = mentionRecords.filter((m) => m.targetType === 'USER' && m.targetId);
    for (const mention of userMentions) {
      await this.notifyMentionedUser(mention.targetId!, { messageId, chatId, mentionedBy: senderId, mentionType: 'USER' });
    }

    const hasBroadcast = mentionRecords.some((m) => m.targetType === 'HERE' || m.targetType === 'CHANNEL');
    if (hasBroadcast) {
      await publishEvent('mention.broadcast', {
        messageId, chatId, mentionedBy: senderId,
        types: mentionRecords.filter((m) => m.targetType !== 'USER').map((m) => m.targetType),
      });
    }

    logger.info({ messageId, mentionCount: mentionRecords.length }, 'Mentions processed');
    return mentionRecords;
  }

  private async notifyMentionedUser(
    userId: string,
    payload: { messageId: string; chatId: string; mentionedBy: string; mentionType: MentionTargetType }
  ) {
    await publishEvent(EventSubjects.USER_MENTIONED, { userId, ...payload, timestamp: new Date().toISOString() });
  }

  async getMentionsForUser(userId: string, options: { cursor?: string; limit?: number } = {}) {
    const { cursor, limit = 20 } = options;
    const take = Math.min(limit, 50);

    const whereCondition: any = { targetId: userId, targetType: 'USER', message: { destroy: false } };
    if (cursor) whereCondition.createdAt = { lt: new Date(cursor) };

    const mentions = await prisma.mention.findMany({
      where: whereCondition,
      include: { message: { select: { id: true, chatId: true, senderId: true, content: true, time: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });

    const lastMention = mentions[mentions.length - 1];
    return {
      mentions: mentions.map((m) => ({
        id: m.id, messageId: m.messageId, chatId: m.message.chatId, senderId: m.message.senderId,
        content: m.message.content?.substring(0, 200), time: m.message.time, mentionedAt: m.createdAt,
      })),
      nextCursor: mentions.length === take && lastMention ? lastMention.createdAt.toISOString() : null,
    };
  }

  async getUnreadMentionCount(userId: string, lastSeenAt?: Date) {
    const whereCondition: any = { targetId: userId, targetType: 'USER', message: { destroy: false } };
    if (lastSeenAt) whereCondition.createdAt = { gt: lastSeenAt };
    return prisma.mention.count({ where: whereCondition });
  }
}

export const mentionService = new MentionService();
