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

  async processMentions(
    messageId: string, 
    content: string, 
    chatId: string, 
    senderId: string,
    metadata?: { senderName?: string, chatName?: string }
  ) {
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

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { workspaceId: true }
    });
    const workspaceId = chat?.workspaceId;

    const userMentions = mentionRecords.filter((m) => m.targetType === 'USER' && m.targetId);
    const notifiedUserIds = new Set<string>();

    let activeUserMentions = userMentions;
    if (workspaceId) {
      const targetUserIds = userMentions.map(m => m.targetId).filter(Boolean) as string[];
      if (targetUserIds.length > 0) {
        try {
          const activeMembers = await prisma.workspaceMember.findMany({
            where: {
              workspaceId,
              userId: { in: targetUserIds },
              leftAt: null,
            },
            select: { userId: true },
          });
          const activeMemberIds = new Set(activeMembers.map(m => m.userId));
          activeUserMentions = userMentions.filter(m => m.targetId && activeMemberIds.has(m.targetId));
        } catch (e) {
          logger.warn({ workspaceId }, 'Failed to filter target users by workspace membership in processMentions');
        }
      }
    }

    for (const mention of activeUserMentions) {
      if (mention.targetId) {
        await this.notifyMentionedUser(mention.targetId, { 
          messageId, 
          chatId, 
          mentionedBy: senderId, 
          mentionType: 'USER',
          senderName: metadata?.senderName,
          chatName: metadata?.chatName
        });
        notifiedUserIds.add(mention.targetId);
      }
    }

    const hasBroadcast = mentionRecords.some((m) => m.targetType === 'HERE' || m.targetType === 'CHANNEL');
    if (hasBroadcast) {
      // Fetch participants to notify
      const participants = await prisma.chatParticipant.findMany({
        where: { chatId },
        select: { accountId: true }
      });
      
      // Filter out: sender AND users who already got a direct mention notification
      let participantIds = participants
        .map(p => p.accountId)
        .filter(id => id !== senderId && !notifiedUserIds.has(id));

      if (workspaceId && participantIds.length > 0) {
        try {
          const activeMembers = await prisma.workspaceMember.findMany({
            where: {
              workspaceId,
              userId: { in: participantIds },
              leftAt: null,
            },
            select: { userId: true },
          });
          const activeMemberIds = new Set(activeMembers.map(m => m.userId));
          participantIds = participantIds.filter(id => activeMemberIds.has(id));
        } catch (e) {
          logger.warn({ workspaceId }, 'Failed to filter participants by workspace membership in processMentions broadcast');
        }
      }

      if (participantIds.length > 0) {
        await publishEvent(EventSubjects.MENTION_BROADCAST, {
          messageId, 
          chatId, 
          mentionedBy: senderId,
          participantIds,
          senderName: metadata?.senderName,
          chatName: metadata?.chatName,
          types: mentionRecords.filter((m) => m.targetType !== 'USER').map((m) => m.targetType),
        });
      }
    }

    logger.info({ messageId, mentionCount: mentionRecords.length }, 'Mentions processed');
    return mentionRecords;
  }

  private async notifyMentionedUser(
    userId: string,
    payload: { 
      messageId: string; 
      chatId: string; 
      mentionedBy: string; 
      mentionType: MentionTargetType;
      senderName?: string;
      chatName?: string;
    }
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
