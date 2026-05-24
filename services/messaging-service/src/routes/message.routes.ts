// services/messaging-service/src/routes/message.routes.ts
// Message routes — migrated from chat-service

import { Router } from 'express';
import type { Request, Response } from 'express';
import { messageService } from '../services/message.service.js';
import { readReceiptService } from '../services/readreceipt.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const messageRoutes = Router();

// GET /summary — internal summary endpoint (now used directly by chatService, but kept for backward compat)
messageRoutes.get('/summary', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const chatIdsStr = req.query.chatIds as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!chatIdsStr) return res.json({ success: true, summary: [] });
  const chatIds = chatIdsStr.split(',');
  const summary = await messageService.getChatSummary(userId, chatIds);
  res.json({ success: true, summary });
}));

// POST /chats/:chatId/read — mark as read (internal endpoint from old chat-service)
messageRoutes.post('/chats/:chatId/read', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const { messageId } = req.body;
  await readReceiptService.markAsRead(chatId as string, userId, messageId);
  res.json({ success: true, message: 'Marked as read' });
}));

// GET /:chatId
messageRoutes.get('/:chatId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { cursor, limit } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await messageService.getMessages(chatId as string, userId, {
    cursor: cursor as string, limit: limit ? parseInt(limit as string) : undefined,
  });
  res.json({ success: true, ...result });
}));

// POST /:chatId
messageRoutes.post('/:chatId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { content, type, replyToId, fileName, fileSize, fileType } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const message = await messageService.sendMessage(chatId as string, userId, { content, type, replyToId, fileName, fileSize, fileType });
  res.status(201).json({
    success: true,
    message: {
      id: message.id, content: message.content, type: message.type, time: message.time,
      senderId: message.senderId, sender: (message as any).sender, replyTo: (message as any).replyTo,
      file: message.fileName ? { name: message.fileName, size: message.fileSize, type: message.fileType } : null,
      reactions: [], isMe: true,
    },
  });
}));

// DELETE /:messageId
messageRoutes.delete('/:messageId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { messageId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await messageService.deleteMessageForMe(messageId as string, userId);
  res.json({ success: true, message: 'Đã xóa tin nhắn!' });
}));

// DELETE /:messageId/recall
messageRoutes.delete('/:messageId/recall', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { messageId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await messageService.recallMessage(messageId as string, userId);
  res.json({ success: true, message: 'Đã thu hồi tin nhắn!' });
}));

// POST /:messageId/react
messageRoutes.post('/:messageId/react', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { messageId } = req.params;
  const { emoji } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!emoji) return res.status(400).json({ success: false, message: 'Vui lòng chọn emoji!' });
  const result = await messageService.reactMessage(messageId as string, userId, emoji);
  res.json({ success: true, ...result });
}));

// PUT /:messageId/pin
messageRoutes.put('/:messageId/pin', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { messageId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await messageService.togglePinMessage(messageId as string, userId);
  res.json({ success: true, message: result.pin ? 'Đã ghim tin nhắn!' : 'Đã bỏ ghim tin nhắn!', ...result });
}));

// GET /:chatId/pinned
messageRoutes.get('/:chatId/pinned', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const pinnedMessages = await messageService.getPinnedMessages(chatId as string, userId);
  res.json({
    success: true,
    pinnedMessages: pinnedMessages.map((msg) => ({
      id: msg.id, content: msg.content, type: msg.type, time: msg.time,
      senderId: msg.senderId, sender: (msg as any).sender,
    })),
  });
}));

// GET /:chatId/search
messageRoutes.get('/:chatId/search', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { q } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const messages = await messageService.searchMessages(chatId as string, q as string, userId);
  res.json({
    success: true,
    messages: messages.map((msg) => ({ id: msg.id, content: msg.content, time: msg.time, senderId: msg.senderId, sender: (msg as any).sender })),
  });
}));

// GET /:chatId/media
messageRoutes.get('/:chatId/media', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { chatId } = req.params;
  const { type } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const messages = await messageService.getMediaMessages(chatId as string, type as string, userId);
  res.json({
    success: true,
    media: messages.map((msg) => ({
      id: msg.id, content: msg.content, type: msg.type, fileName: msg.fileName,
      fileSize: msg.fileSize, fileType: msg.fileType, time: msg.time,
      senderId: msg.senderId, sender: (msg as any).sender,
    })),
  });
}));
