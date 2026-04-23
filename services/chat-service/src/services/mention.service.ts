// services/chat-service/src/services/mention.service.ts
// Mention System for MSG-06: @user, @here, @channel

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

// Mention target types
export type MentionTargetType = 'USER' | 'HERE' | 'CHANNEL' | 'AI';

export interface ParsedMention {
  type: MentionTargetType;
  targetId?: string;
  raw: string; // The original @mention text
}

export class MentionService {
  // Regex patterns for mention detection
  private static readonly USER_MENTION_REGEX = /@\[([^\]]+)\]\(([a-f0-9-]+)\)/g; // @[User Name](userId)
  private static readonly SIMPLE_USER_REGEX = /@([a-zA-Z0-9_]+)/g; // @username
  private static readonly HERE_REGEX = /@here\b/gi;
  private static readonly CHANNEL_REGEX = /@channel\b/gi;

  /**
   * Extract mentions from message content
   */
  extractMentions(content: string): ParsedMention[] {
    const mentions: ParsedMention[] = [];

    if (!content) return mentions;

    // Extract @[User Name](userId) format (rich text editor style)
    // Create fresh regex each call to avoid lastIndex issues
    // Pattern accepts alphanumeric userId (not just UUID hex)
    const userMentionRegex = /@\[([^\]]+)\]\(([a-zA-Z0-9_-]+)\)/g;
    let match;
    while ((match = userMentionRegex.exec(content)) !== null) {
      mentions.push({
        type: 'USER',
        targetId: match[2],
        raw: match[0],
      });
    }

    // Extract @here (case-insensitive, fresh regex)
    if (/@here\b/i.test(content)) {
      mentions.push({
        type: 'HERE',
        raw: '@here',
      });
    }

    // Extract @channel (case-insensitive, fresh regex)
    if (/@channel\b/i.test(content)) {
      mentions.push({
        type: 'CHANNEL',
        raw: '@channel',
      });
    }
    
    // Extract @AI (case-insensitive)
    if (/@AI\b/i.test(content)) {
      mentions.push({
        type: 'AI',
        raw: '@AI',
      });
    }
    return mentions;
  }

  /**
   * Process and save mentions for a message
   */
  async processMentions(
    messageId: string,
    content: string,
    chatId: string,
    senderId: string
  ) {
    const parsedMentions = this.extractMentions(content);

    if (parsedMentions.length === 0) {
      return [];
    }

    // Create mention records
    const mentionRecords = await Promise.all(
      parsedMentions.map(async (mention) => {
        const record = await prisma.mention.create({
          data: {
            id: uuidv4(),
            messageId,
            targetType: mention.type,
            targetId: mention.targetId || null,
          },
        });

        return {
          ...record,
          raw: mention.raw,
        };
      })
    );

    // Notify mentioned users (USER type)
    const userMentions = mentionRecords.filter((m) => m.targetType === 'USER' && m.targetId);
    for (const mention of userMentions) {
      await this.notifyMentionedUser(mention.targetId!, {
        messageId,
        chatId,
        mentionedBy: senderId,
        mentionType: 'USER',
      });
    }

    // For @here and @channel, we'll publish a broadcast event
    // (the ws-gateway will handle expanding to actual users)
    const hasBroadcast = mentionRecords.some(
      (m) => m.targetType === 'HERE' || m.targetType === 'CHANNEL'
    );

    if (hasBroadcast) {
      await publishEvent('mention.broadcast', {
        messageId,
        chatId,
        mentionedBy: senderId,
        types: mentionRecords
          .filter((m) => m.targetType !== 'USER')
          .map((m) => m.targetType),
      });
    }

    logger.info(
      { messageId, mentionCount: mentionRecords.length },
      'Mentions processed'
    );

    return mentionRecords;
  }

  /**
   * Notify a specific user that they were mentioned
   */
  private async notifyMentionedUser(
    userId: string,
    payload: {
      messageId: string;
      chatId: string;
      mentionedBy: string;
      mentionType: MentionTargetType;
    }
  ) {
    await publishEvent(EventSubjects.USER_MENTIONED || 'user.mentioned', {
      userId,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get all mentions for a user (paginated)
   */
  async getMentionsForUser(
    userId: string,
    options: { cursor?: string; limit?: number } = {}
  ) {
    const { cursor, limit = 20 } = options;
    const take = Math.min(limit, 50);

    const whereCondition: any = {
      targetId: userId,
      targetType: 'USER',
      message: { destroy: false },
    };

    if (cursor) {
      whereCondition.createdAt = { lt: new Date(cursor) };
    }

    const mentions = await prisma.mention.findMany({
      where: whereCondition,
      include: {
        message: {
          select: {
            id: true,
            chatId: true,
            senderId: true,
            content: true,
            time: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    const lastMention = mentions[mentions.length - 1];

    return {
      mentions: mentions.map((m) => ({
        id: m.id,
        messageId: m.messageId,
        chatId: m.message.chatId,
        senderId: m.message.senderId,
        content: m.message.content?.substring(0, 200), // Preview only
        time: m.message.time,
        mentionedAt: m.createdAt,
      })),
      nextCursor:
        mentions.length === take && lastMention
          ? lastMention.createdAt.toISOString()
          : null,
    };
  }

  /**
   * Get unread mention count for a user
   */
  async getUnreadMentionCount(userId: string, lastSeenAt?: Date) {
    const whereCondition: any = {
      targetId: userId,
      targetType: 'USER',
      message: { destroy: false },
    };

    if (lastSeenAt) {
      whereCondition.createdAt = { gt: lastSeenAt };
    }

    return prisma.mention.count({ where: whereCondition });
  }
}

export const mentionService = new MentionService();
