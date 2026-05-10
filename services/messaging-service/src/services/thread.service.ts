// services/messaging-service/src/services/thread.service.ts
// Thread System — migrated from chat-service (no changes needed)

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export class ThreadService {
  async createThreadReply(
    parentId: string,
    senderId: string,
    input: { content: string; type?: string; fileName?: string; fileSize?: string; fileType?: string }
  ) {
    const { content, type = 'text', fileName, fileSize, fileType } = input;
    const parentMessage = await prisma.message.findUnique({ where: { id: parentId } });
    if (!parentMessage) throw new Error('Parent message not found!');
    if (parentMessage.destroy) throw new Error('Cannot reply to a deleted message!');

    const rootThreadId = parentMessage.rootThreadId || parentId;

    const reply = await prisma.message.create({
      data: {
        id: uuidv4(), chatId: parentMessage.chatId, senderId,
        content: content?.trim() || null, type, parentId, rootThreadId,
        fileName: fileName || null, fileSize: fileSize || null, fileType: fileType || null,
      },
    });

    await prisma.message.update({ where: { id: parentId }, data: { replyCount: { increment: 1 } } });

    await publishEvent(EventSubjects.THREAD_REPLY_CREATED, {
      id: reply.id, chatId: reply.chatId, parentId: reply.parentId, rootThreadId: reply.rootThreadId,
      senderId: reply.senderId, content: reply.content, type: reply.type, time: reply.time.toISOString(),
      file: fileName ? { name: fileName, size: fileSize, type: fileType } : null,
    });

    logger.info({ replyId: reply.id, parentId, chatId: reply.chatId }, 'Thread reply created');
    return reply;
  }

  async getThreadReplies(parentId: string, options: { cursor?: string; limit?: number } = {}) {
    const { cursor, limit = 50 } = options;
    const take = Math.min(limit, 100);

    const parentMessage = await prisma.message.findUnique({
      where: { id: parentId }, select: { id: true, chatId: true, replyCount: true },
    });
    if (!parentMessage) throw new Error('Parent message not found!');

    const whereCondition: any = { parentId, destroy: false };
    if (cursor) whereCondition.time = { gt: new Date(cursor) };

    const replies = await prisma.message.findMany({
      where: whereCondition, include: { reactions: true }, orderBy: { time: 'asc' }, take,
    });

    const formattedReplies = replies.map((msg) => ({
      id: msg.id, content: msg.content, type: msg.type, time: msg.time, senderId: msg.senderId, parentId: msg.parentId,
      file: msg.fileName ? { name: msg.fileName, size: msg.fileSize, type: msg.fileType } : null,
      reactions: this.groupReactions(msg.reactions),
    }));

    const lastReply = replies[replies.length - 1];
    return {
      parentId, chatId: parentMessage.chatId, totalReplies: parentMessage.replyCount, replies: formattedReplies,
      nextCursor: replies.length === take && lastReply ? lastReply.time.toISOString() : null,
    };
  }

  async getThreadPreview(parentId: string) {
    const parentMessage = await prisma.message.findUnique({ where: { id: parentId }, select: { id: true, replyCount: true } });
    if (!parentMessage) return null;

    const latestReplies = await prisma.message.findMany({
      where: { parentId, destroy: false }, orderBy: { time: 'desc' }, take: 3,
      select: { id: true, senderId: true, content: true, time: true },
    });

    return { parentId, replyCount: parentMessage.replyCount, latestReplies: latestReplies.reverse() };
  }

  async getActiveThreads(chatId: string, limit = 10) {
    return prisma.message.findMany({
      where: { chatId, replyCount: { gt: 0 }, destroy: false, parentId: null },
      orderBy: { time: 'desc' }, take: limit,
      select: { id: true, content: true, senderId: true, time: true, replyCount: true },
    });
  }

  async getThreadParticipants(parentId: string) {
    const replies = await prisma.message.findMany({
      where: { parentId, destroy: false }, select: { senderId: true }, distinct: ['senderId'],
    });
    return replies.map((r) => r.senderId);
  }

  private groupReactions(reactions: any[]) {
    return reactions.reduce((acc: any[], r) => {
      const existing = acc.find((a) => a.emoji === r.reaction);
      if (existing) { existing.count += 1; existing.userIds.push(r.userId); }
      else { acc.push({ emoji: r.reaction, count: 1, userIds: [r.userId] }); }
      return acc;
    }, []);
  }
}

export const threadService = new ThreadService();
