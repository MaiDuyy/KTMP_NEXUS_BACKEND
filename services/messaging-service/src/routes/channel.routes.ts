// services/messaging-service/src/routes/channel.routes.ts
// Channel routes — migrated from group-service

import { Router } from 'express';
import type { Request, Response } from 'express';
import { channelService } from '../services/channel.service.js';
import { channelCategoryService } from '../services/channel-category.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { userorgClient } from '../lib/userorgClient.js';
import type { ChannelType } from '@prisma/client';

export const channelRoutes = Router();

// ==================== CHANNEL CRUD ====================

channelRoutes.post('/workspaces/:wsId/channels', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { name, description, topic, type, categoryId, isDefault } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!name) return res.status(400).json({ success: false, message: 'Tên channel là bắt buộc!' });
  const channel = await channelService.createChannel(wsId as string, { name, description, topic, type: type as ChannelType, categoryId, isDefault }, userId);
  res.status(201).json({ success: true, message: 'Tạo channel thành công!', channel });
}));

channelRoutes.get('/workspaces/:wsId/channels', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { includeArchived } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const channels = await channelService.listChannels(wsId as string, userId, includeArchived === 'true');
  res.json({ success: true, channels });
}));

channelRoutes.get('/workspaces/:wsId/channels/browse', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { page, limit, search } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await channelService.browseChannels(wsId as string, userId, {
    page: page ? parseInt(page as string) : undefined, limit: limit ? parseInt(limit as string) : undefined, search: search as string,
  });
  res.json({ success: true, ...result });
}));

// ==================== CATEGORY ROUTES ====================

channelRoutes.get('/workspaces/:wsId/categories', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const categories = await channelCategoryService.listCategories(wsId as string, userId);
  res.json({ success: true, categories });
}));

channelRoutes.post('/workspaces/:wsId/categories', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { name, position } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const category = await channelCategoryService.createCategory(wsId as string, { name, position }, userId);
  res.status(201).json({ success: true, category });
}));

channelRoutes.put('/categories/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { name, position } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const category = await channelCategoryService.updateCategory(id as string, { name, position }, userId);
  res.json({ success: true, category });
}));

channelRoutes.delete('/categories/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await channelCategoryService.deleteCategory(id as string, userId);
  res.json({ success: true, message: 'Đã xóa category!' });
}));

// ==================== CHANNEL SINGLE ====================

channelRoutes.get('/channels/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const channel = await channelService.getChannel(id as string, userId);
  res.json({ success: true, channel });
}));

channelRoutes.put('/channels/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { name, description, topic, categoryId, position } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const channel = await channelService.updateChannel(id as string, { name, description, topic, categoryId, position }, userId);
  res.json({ success: true, message: 'Cập nhật channel thành công!', channel });
}));

channelRoutes.delete('/channels/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await channelService.deleteChannel(id as string, userId);
  res.json({ success: true, message: 'Xóa channel thành công!' });
}));

// Archive
channelRoutes.post('/channels/:id/archive', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const channel = await channelService.archiveChannel(id as string, userId);
  res.json({ success: true, message: 'Channel đã được archive!', channel });
}));

channelRoutes.post('/channels/:id/unarchive', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const channel = await channelService.unarchiveChannel(id as string, userId);
  res.json({ success: true, message: 'Channel đã được unarchive!', channel });
}));

// Members
channelRoutes.get('/channels/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const channel = await channelService.getChannel(id as string, userId);
  const memberUserIds = channel.members.map(m => m.userId);
  const userMap = await userorgClient.getUsers(memberUserIds);
  const populatedMembers = channel.members.map(m => {
    const userObj = userMap.get(m.userId);
    return {
      ...m,
      user: userObj ? { id: userObj.id, name: userObj.name, avatar: userObj.avatar } : { id: m.userId, name: m.userId }
    };
  });
  res.json({ success: true, members: populatedMembers, total: channel._count.members });
}));

channelRoutes.post('/channels/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { targetUserId } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!targetUserId) return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
  const member = await channelService.addMember(id as string, targetUserId, userId);
  res.status(201).json({ success: true, message: 'Thêm thành viên thành công!', member });
}));

channelRoutes.delete('/channels/:id/members/:targetUserId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id, targetUserId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await channelService.removeMember(id as string, targetUserId as string, userId);
  res.json({ success: true, message: userId === targetUserId ? 'Đã rời channel!' : 'Đã xóa thành viên!' });
}));

channelRoutes.put('/channels/:id/members/:targetUserId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id, targetUserId } = req.params;
  const { canPost } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (canPost === undefined) return res.status(400).json({ success: false, message: 'canPost là bắt buộc!' });
  const member = await channelService.updateMemberPermission(id as string, targetUserId as string, canPost, userId);
  res.json({ success: true, message: 'Cập nhật quyền thành công!', member });
}));

// Join / Leave
channelRoutes.post('/channels/:id/join', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const member = await channelService.joinPublicChannel(id as string, userId);
  res.status(201).json({ success: true, message: 'Đã tham gia channel!', member });
}));

channelRoutes.post('/channels/:id/leave', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await channelService.leaveChannel(id as string, userId);
  res.json({ success: true, message: 'Đã rời channel!' });
}));

// Default / Preferences
channelRoutes.put('/channels/:id/default', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { isDefault } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (isDefault === undefined) return res.status(400).json({ success: false, message: 'isDefault là bắt buộc!' });
  const channel = await channelService.setDefaultChannel(id as string, isDefault, userId);
  res.json({ success: true, message: isDefault ? 'Channel đã được đặt làm mặc định!' : 'Channel không còn là mặc định!', channel });
}));

channelRoutes.put('/channels/:id/preferences', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { isMuted, isPinned } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const member = await channelService.updateMemberPreferences(id as string, userId, { isMuted, isPinned });
  res.json({ success: true, message: 'Cập nhật preferences thành công!', member });
}));
