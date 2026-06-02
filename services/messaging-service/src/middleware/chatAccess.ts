// services/messaging-service/src/middleware/chatAccess.ts

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

// Extend Express Request type to support decoded user information from headers or JWT middleware
export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    workspaceId: string;
    roles: string[];
    isActive: boolean;
  };
}

/**
 * Checks if a user has access to a specific chat room.
 * Implements strict RBAC logic:
 * 1. For PUBLIC channels/groups: Allowed if explicit participant OR Admin (SUPER_ADMIN, WORKSPACE_ADMIN, WORKSPACE_OWNER, WORKSPACE_MANAGER).
 * 2. For PRIVATE/DM channels/groups: Allowed ONLY if explicit participant (no bypass for anyone).
 * 
 * Supports backward compatibility where roles and userWorkspaceId might not be provided (defaults to strict checks).
 * Uses Redis for high-performance caching.
 */
export async function hasChatAccess(
  chatId: string,
  userId: string,
  roles?: string[],
  userWorkspaceId?: string
): Promise<boolean> {
  const memberKey = `chat:member:${chatId}:${userId}`;
  const cachedMember = await redis.get(memberKey);

  if (cachedMember === 'true') return true;
  if (cachedMember === 'false') return false;

  const userRoles = roles || [];
  
  // Check if the user has any system-wide or workspace-level administrative roles
  const isAdmin = userRoles.includes('SUPER_ADMIN') || 
                  userRoles.includes('WORKSPACE_ADMIN') || 
                  userRoles.includes('WORKSPACE_OWNER') || 
                  userRoles.includes('WORKSPACE_MANAGER');

  // Cache miss: check database
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: {
      workspaceId: true,
      isGroup: true,
      joinPolicy: true,
    },
  });

  if (!chat) {
    await redis.setex(memberKey, 600, 'false');
    return false;
  }

  // Tenant Boundary Check: enforce it matches the chat's workspaceId
  // System-wide SUPER_ADMIN is exempt from this workspace boundary check to allow global auditing.
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');
  if (!isSuperAdmin && userWorkspaceId && chat.workspaceId && chat.workspaceId !== userWorkspaceId) {
    await redis.setex(memberKey, 600, 'false');
    return false;
  }

  // Check explicit participant status in the chat room
  const participant = await prisma.chatParticipant.findUnique({
    where: { chatId_accountId: { chatId, accountId: userId } },
  });

  const isParticipant = !!participant;
  let hasAccess = false;

  // Apply visibility rules
  if (chat.isGroup && chat.joinPolicy === 'PUBLIC') {
    // PUBLIC Channel/Group -> Admins can bypass, others must join
    if (isAdmin || isParticipant) {
      hasAccess = true;
    } else if (!roles && chat.workspaceId) {
      // Backward compatibility fallback for internal service calls: check if workspace member
      const workspaceMember = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: chat.workspaceId, userId } },
      });
      if (workspaceMember && workspaceMember.leftAt === null) {
        hasAccess = true;
      }
    }
  } else {
    // PRIVATE/DM -> Strictly must be a participant (no bypass for anyone)
    if (isParticipant) {
      hasAccess = true;
    }
  }

  await redis.setex(memberKey, 600, hasAccess ? 'true' : 'false');
  return hasAccess;
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
 * Implements a robust hybrid check supporting both JWT middleware user context and API Gateway forwarded headers.
 */
export async function checkChatAccessMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const user = req.user;
    
    // 1. Resolve userId from either req.user (internal JWT middleware) or Gateway Headers
    const userId = user?.userId || (req.headers['x-user-id'] as string);
    if (!userId) {
      return res.status(401).json({
        success: false,
        errorCode: 'UNAUTHORIZED_OR_INACTIVE',
        message: 'Tài khoản chưa đăng nhập hoặc đã bị vô hiệu hóa.',
      });
    }

    // Block inactive users from req.user if explicitly present and inactive
    if (user && user.isActive === false) {
      return res.status(401).json({
        success: false,
        errorCode: 'UNAUTHORIZED_OR_INACTIVE',
        message: 'Tài khoản đã bị vô hiệu hóa.',
      });
    }

    // Resolve workspaceId
    const workspaceId = user?.workspaceId || (req.headers['x-workspace-id'] || '') as string;
    
    // Resolve roles list
    let roles: string[] = [];
    if (user?.roles) {
      roles = user.roles;
    } else {
      const rawRoles = req.headers['x-user-roles'] as string;
      if (rawRoles) {
        try {
          roles = JSON.parse(rawRoles);
        } catch {
          roles = [rawRoles];
        }
      } else {
        const singleRole = req.headers['x-user-role'] as string;
        if (singleRole) {
          roles = [singleRole];
        }
      }
    }

    const chatId = req.params.chatId || req.body.chatId || req.query.chatId || req.body.targetChatId;
    if (!chatId) {
      return next();
    }

    const hasAccess = await hasChatAccess(chatId as string, userId, roles, workspaceId);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        errorCode: 'ACCESS_DENIED',
        message: 'Bạn không có quyền truy cập hoặc xem tin nhắn trong phòng chat này.',
      });
    }

    next();
  } catch (err) {
    logger.error({ err }, 'Error in checkChatAccessMiddleware');
    next(err);
  }
}
