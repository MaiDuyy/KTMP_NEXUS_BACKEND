// services/messaging-service/src/middleware/chatAccess.ts

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Checks if a user has access to a specific chat room.
 * Implements standard participants check and public workspace channel fallback.
 * Uses Redis for high-performance caching.
 */
export async function hasChatAccess(chatId: string, userId: string): Promise<boolean> {
  const memberKey = `chat:member:${chatId}:${userId}`;
  const cachedMember = await redis.get(memberKey);

  if (cachedMember === 'true') return true;
  if (cachedMember === 'false') return false;

  // Cache miss: check DB
  // 1. Is explicit participant?
  const participant = await prisma.chatParticipant.findFirst({
    where: { chatId, accountId: userId }
  });

  if (participant) {
    await redis.setex(memberKey, 600, 'true'); // Cache for 10 minutes
    return true;
  }

  // 2. Check public workspace channel fallback
  const metaKey = `chat:meta:${chatId}`;
  const cachedMeta = await redis.get(metaKey);
  let metadata: { workspaceId: string | null; joinPolicy: string } | null = null;

  if (cachedMeta) {
    try {
      metadata = JSON.parse(cachedMeta);
    } catch {
      metadata = null;
    }
  }

  if (!metadata) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { workspaceId: true, joinPolicy: true }
    });

    if (chat) {
      metadata = { workspaceId: chat.workspaceId, joinPolicy: chat.joinPolicy };
      await redis.setex(metaKey, 600, JSON.stringify(metadata));
    }
  }

  if (metadata && metadata.workspaceId && metadata.joinPolicy === 'PUBLIC') {
    const workspaceMember = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: metadata.workspaceId,
          userId
        }
      }
    });

    if (workspaceMember && workspaceMember.leftAt === null) {
      await redis.setex(memberKey, 600, 'true');
      return true;
    }
  }

  await redis.setex(memberKey, 600, 'false');
  return false;
}

/**
 * Clear cached membership access for a single user in a chat.
 */
export async function clearChatMemberCache(chatId: string, userId: string) {
  await redis.del(`chat:member:${chatId}:${userId}`);
}

/**
 * Clear all cached membership access and metadata for a chat.
 */
export async function clearChatCache(chatId: string) {
  await redis.del(`chat:meta:${chatId}`);
  let cursor = '0';
  do {
    const reply = await redis.scan(cursor, 'MATCH', `chat:member:${chatId}:*`, 'COUNT', 100);
    cursor = reply[0];
    const keys = reply[1];
    if (keys && keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}

/**
 * Express middleware to verify chat access based on chatId in request.
 */
export function checkChatAccessMiddleware(req: Request, res: Response, next: NextFunction) {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const chatId = req.params.chatId || req.body.chatId || req.query.chatId || req.body.targetChatId;
  
  if (!chatId) {
    return next();
  }

  hasChatAccess(chatId as string, userId)
    .then((hasAccess) => {
      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          message: 'Bạn không còn là thành viên của nhóm này nên không thể xem nội dung'
        });
      }
      next();
    })
    .catch((err) => {
      logger.error({ err, chatId, userId }, 'Error in checkChatAccessMiddleware');
      next(err);
    });
}
