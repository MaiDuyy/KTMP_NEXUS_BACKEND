// services/chat-service/src/routes/readreceipt.routes.ts
// Read Receipt API Routes for MSG-12

import { Router } from 'express';
import type { Request, Response } from 'express';
import { readReceiptService } from '../services/readreceipt.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const readReceiptRoutes = Router();

/**
 * POST /chats/:chatId/read - Mark messages as read
 */
readReceiptRoutes.post('/:chatId/read', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { messageId } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const receipt = await readReceiptService.markAsRead(chatId as string, userId, messageId);

  if (!receipt) {
    return res.json({ success: true, message: 'No messages to mark as read' });
  }

  res.json({
    success: true,
    receipt: {
      chatId: receipt.chatId,
      messageId: receipt.messageId,
      readAt: receipt.readAt,
    },
  });
}));

/**
 * GET /chats/:chatId/receipts - Get read receipts for a chat
 */
readReceiptRoutes.get('/:chatId/receipts', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const receipts = await readReceiptService.getReadReceipts(chatId as string);

  res.json({
    success: true,
    receipts,
  });
}));

/**
 * GET /chats/:chatId/unread-count - Get unread message count
 */
readReceiptRoutes.get('/:chatId/unread-count', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const count = await readReceiptService.getUnreadCount(chatId as string, userId);

  res.json({
    success: true,
    unreadCount: count,
  });
}));

/**
 * POST /chats/batch-unread - Get unread counts for multiple chats
 */
readReceiptRoutes.post('/batch-unread', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatIds } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!Array.isArray(chatIds) || chatIds.length === 0) {
    return res.status(400).json({ success: false, message: 'chatIds array is required!' });
  }

  const counts = await readReceiptService.getBatchUnreadCounts(chatIds, userId);

  res.json({
    success: true,
    unreadCounts: counts,
  });
}));
