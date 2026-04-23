// services/chat-service/src/routes/mention.routes.ts
// Mention API Routes for MSG-06

import { Router } from 'express';
import type { Request, Response } from 'express';
import { mentionService } from '../services/mention.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const mentionRoutes = Router();

/**
 * GET /mentions - Get mentions for the current user
 */
mentionRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { cursor, limit } = req.query;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await mentionService.getMentionsForUser(userId, {
    cursor: cursor as string,
    limit: limit ? parseInt(limit as string) : undefined,
  });

  res.json({
    success: true,
    ...result,
  });
}));

/**
 * GET /mentions/unread-count - Get unread mention count
 */
mentionRoutes.get('/unread-count', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { since } = req.query;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const count = await mentionService.getUnreadMentionCount(
    userId,
    since ? new Date(since as string) : undefined
  );

  res.json({
    success: true,
    unreadCount: count,
  });
}));
