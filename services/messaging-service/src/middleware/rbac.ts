// services/messaging-service/src/middleware/rbac.ts
// Middleware to enforce strict RBAC for channel visibility and message reading rules

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

// Extend Express Request type
export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    workspaceId: string;
    roles: string[];
    isActive: boolean;
  };
}

/**
 * High-performance access check using Redis caching.
 * Key structure: rbac:channel:access:${workspaceId}:${channelId}:${userId}
 */
async function getCachedAccess(
  userId: string,
  workspaceId: string,
  channelId: string
): Promise<boolean | null> {
  const cacheKey = `rbac:channel:access:${workspaceId}:${channelId}:${userId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached === 'true') return true;
    if (cached === 'false') return false;
  } catch (err) {
    logger.error({ err, cacheKey }, 'Failed to read from Redis cache');
  }
  return null;
}

/**
 * Cache authorization decisions for 5 minutes (300 seconds)
 */
async function setCachedAccess(
  userId: string,
  workspaceId: string,
  channelId: string,
  hasAccess: boolean
): Promise<void> {
  const cacheKey = `rbac:channel:access:${workspaceId}:${channelId}:${userId}`;
  try {
    await redis.setex(cacheKey, 300, hasAccess ? 'true' : 'false');
  } catch (err) {
    logger.error({ err, cacheKey }, 'Failed to set Redis cache');
  }
}

/**
 * Clears all cached access rights when a member joins or leaves a channel.
 */
export async function invalidateChannelAccessCache(channelId: string, userId: string): Promise<void> {
  try {
    const keys = await redis.keys(`rbac:channel:access:*:${channelId}:${userId}`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    logger.error({ err, channelId, userId }, 'Failed to invalidate Redis cache');
  }
}

/**
 * Express middleware to enforce Role-Based Access Control regarding channel and message visibility.
 * Implements strict multi-tenant boundary checks and extracts user details dynamically from either req.user or HTTP headers.
 */
export async function checkChannelVisibility(
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

    const channelId = req.params.channelId || req.query.channelId || req.body.channelId;
    if (!channelId) {
      return res.status(400).json({
        success: false,
        errorCode: 'MISSING_CHANNEL_ID',
        message: 'Yêu cầu thiếu mã kênh (Channel ID).',
      });
    }

    // Check if the user has any system-wide or workspace-level administrative roles
    const isAdmin = roles.includes('SUPER_ADMIN') || 
                    roles.includes('WORKSPACE_ADMIN') || 
                    roles.includes('WORKSPACE_OWNER') || 
                    roles.includes('WORKSPACE_MANAGER');

    const isSuperAdmin = roles.includes('SUPER_ADMIN');

    // 2. High-Performance Caching Check
    const cachedAccess = await getCachedAccess(userId, workspaceId, channelId);
    if (cachedAccess !== null) {
      if (cachedAccess) {
        return next();
      }
      return res.status(403).json({
        success: false,
        errorCode: 'ACCESS_DENIED',
        message: 'Bạn không có quyền truy cập hoặc xem tin nhắn trong kênh này.',
      });
    }

    // 3. Optimized Database Access check (Single Roundtrip)
    // System-wide SUPER_ADMIN is exempt from workspace boundary check
    const channel = await prisma.channel.findFirst({
      where: {
        id: channelId,
        workspaceId: isSuperAdmin ? undefined : workspaceId, // Tenant boundary check (skipped for Super Admin)
      },
      select: {
        type: true,
        members: {
          where: {
            userId: userId,
          },
          select: {
            userId: true,
          },
        },
      },
    });

    // If channel is not found in the workspace context
    if (!channel) {
      await setCachedAccess(userId, workspaceId, channelId, false);
      return res.status(404).json({
        success: false,
        errorCode: 'CHANNEL_NOT_FOUND',
        message: 'Kênh không tồn tại hoặc không thuộc không gian làm việc của bạn.',
      });
    }

    const isMember = channel.members.length > 0;

    // 4. Strict Visibility Logic
    let hasAccess = false;

    if (channel.type === 'PUBLIC') {
      // Rule 1: Admins can fetch and read all messages in any 'PUBLIC' channel, even if they have not explicitly joined it
      // Rule 3: Regular users can only read messages in channels they have explicitly joined
      if (isAdmin || isMember) {
        hasAccess = true;
      }
    } else {
      // Rule 2 & 3: Neither SUPER_ADMIN nor WORKSPACE_MANAGER (or standard users) can bypass PRIVATE/DM privacy.
      // Must be explicitly listed in channel_member table.
      if (isMember) {
        hasAccess = true;
      }
    }

    // 5. Save Decision to Cache
    await setCachedAccess(userId, workspaceId, channelId, hasAccess);

    if (hasAccess) {
      return next();
    }

    return res.status(403).json({
      success: false,
      errorCode: 'ACCESS_DENIED',
      message: 'Bạn không có quyền truy cập hoặc xem tin nhắn trong kênh này.',
    });

  } catch (error) {
    logger.error(error, 'Error in checkChannelVisibility middleware');
    next(error);
  }
}
