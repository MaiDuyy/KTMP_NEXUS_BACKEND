// services/chat-service/src/routes/thread.routes.ts
// Thread API Routes for MSG-07

import { Router } from 'express';
import type { Request, Response } from 'express';
import { threadService } from '../services/thread.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const threadRoutes = Router();

/**
 * POST /threads/:parentId - Create thread reply
 */
threadRoutes.post('/:parentId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { parentId } = req.params;
  const { content, type, fileName, fileSize, fileType } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!content?.trim()) {
    return res.status(400).json({ success: false, message: 'Nội dung không được trống!' });
  }

  const reply = await threadService.createThreadReply(parentId as string, userId, {
    content,
    type,
    fileName,
    fileSize,
    fileType,
  });

  res.status(201).json({
    success: true,
    reply: {
      id: reply.id,
      parentId: reply.parentId,
      content: reply.content,
      type: reply.type,
      time: reply.time,
      senderId: reply.senderId,
      file: reply.fileName
        ? { name: reply.fileName, size: reply.fileSize, type: reply.fileType }
        : null,
    },
  });
}));

/**
 * GET /threads/:parentId - Get thread replies
 */
threadRoutes.get('/:parentId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { parentId } = req.params;
  const { cursor, limit } = req.query;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await threadService.getThreadReplies(parentId as string, {
    cursor: cursor as string,
    limit: limit ? parseInt(limit as string) : undefined,
  });

  res.json({
    success: true,
    ...result,
  });
}));

/**
 * GET /threads/:parentId/preview - Get thread preview (latest 3 replies)
 */
threadRoutes.get('/:parentId/preview', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { parentId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const preview = await threadService.getThreadPreview(parentId as string);

  res.json({
    success: true,
    preview,
  });
}));

/**
 * GET /threads/:parentId/participants - Get thread participants
 */
threadRoutes.get('/:parentId/participants', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { parentId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const participants = await threadService.getThreadParticipants(parentId as string);

  res.json({
    success: true,
    participants,
  });
}));

/**
 * GET /threads/chat/:chatId/active - Get active threads in a chat
 */
threadRoutes.get('/chat/:chatId/active', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { limit } = req.query;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const threads = await threadService.getActiveThreads(
    chatId as string,
    limit ? parseInt(limit as string) : undefined
  );

  res.json({
    success: true,
    threads,
  });
}));
