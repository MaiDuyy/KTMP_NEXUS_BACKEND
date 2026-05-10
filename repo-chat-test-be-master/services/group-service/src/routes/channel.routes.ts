// services/group-service/src/routes/channel.routes.ts
// Channel management endpoints (WS-03 to WS-12)

import { Router } from 'express';
import type { Request, Response } from 'express';
import { channelService } from '../services/channel.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { ChannelType } from '@prisma/client';

export const channelRoutes = Router();

// ==================== CHANNEL CRUD ====================

/**
 * POST /workspaces/:wsId/channels - Create channel (WS-03, WS-04, WS-05)
 */
channelRoutes.post('/workspaces/:wsId/channels', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { name, description, topic, type, categoryId, isDefault } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!name) {
    return res.status(400).json({ success: false, message: 'Tên channel là bắt buộc!' });
  }

  const channel = await channelService.createChannel(
    wsId as string,
    { name, description, topic, type: type as ChannelType, categoryId, isDefault },
    userId
  );

  res.status(201).json({
    success: true,
    message: 'Tạo channel thành công!',
    channel,
  });
}));

/**
 * GET /workspaces/:wsId/channels - List channels in workspace
 */
channelRoutes.get('/workspaces/:wsId/channels', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { includeArchived } = req.query;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const channels = await channelService.listChannels(wsId as string, userId, includeArchived === 'true');

  res.json({
    success: true,
    channels,
  });
}));

/**
 * GET /workspaces/:wsId/channels/browse - Browse public channels (WS-12)
 */
channelRoutes.get('/workspaces/:wsId/channels/browse', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { wsId } = req.params;
  const { page, limit, search } = req.query;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await channelService.browseChannels(wsId as string, userId, {
    page: page ? parseInt(page as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
    search: search as string,
  });

  res.json({
    success: true,
    ...result,
  });
}));

/**
 * GET /channels/:id - Get channel details
 */
channelRoutes.get('/channels/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const channel = await channelService.getChannel(id as string, userId);

  res.json({
    success: true,
    channel,
  });
}));

/**
 * PUT /channels/:id - Update channel
 */
channelRoutes.put('/channels/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { name, description, topic, categoryId, position } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const channel = await channelService.updateChannel(id as string, { name, description, topic, categoryId, position }, userId);

  res.json({
    success: true,
    message: 'Cập nhật channel thành công!',
    channel,
  });
}));

/**
 * DELETE /channels/:id - Delete channel (WS-07)
 */
channelRoutes.delete('/channels/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await channelService.deleteChannel(id as string, userId);

  res.json({
    success: true,
    message: 'Xóa channel thành công!',
  });
}));

// ==================== ARCHIVE (WS-06) ====================

/**
 * POST /channels/:id/archive - Archive channel
 */
channelRoutes.post('/channels/:id/archive', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const channel = await channelService.archiveChannel(id as string, userId);

  res.json({
    success: true,
    message: 'Channel đã được archive!',
    channel,
  });
}));

/**
 * POST /channels/:id/unarchive - Unarchive channel
 */
channelRoutes.post('/channels/:id/unarchive', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const channel = await channelService.unarchiveChannel(id as string, userId);

  res.json({
    success: true,
    message: 'Channel đã được unarchive!',
    channel,
  });
}));

// ==================== MEMBER MANAGEMENT (WS-09, WS-10) ====================

/**
 * GET /channels/:id/members - List channel members
 */
channelRoutes.get('/channels/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const channel = await channelService.getChannel(id as string, userId);

  res.json({
    success: true,
    members: channel.members,
    total: channel._count.members,
  });
}));

/**
 * POST /channels/:id/members - Add member to channel
 */
channelRoutes.post('/channels/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { targetUserId } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!targetUserId) {
    return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
  }

  const member = await channelService.addMember(id as string, targetUserId, userId);

  res.status(201).json({
    success: true,
    message: 'Thêm thành viên thành công!',
    member,
  });
}));

/**
 * DELETE /channels/:id/members/:userId - Remove member from channel
 */
channelRoutes.delete('/channels/:id/members/:targetUserId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id, targetUserId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await channelService.removeMember(id as string, targetUserId as string, userId);

  res.json({
    success: true,
    message: userId === targetUserId ? 'Đã rời channel!' : 'Đã xóa thành viên!',
  });
}));

/**
 * PUT /channels/:id/members/:userId - Update member permissions (WS-10)
 */
channelRoutes.put('/channels/:id/members/:targetUserId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id, targetUserId } = req.params;
  const { canPost } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (canPost === undefined) {
    return res.status(400).json({ success: false, message: 'canPost là bắt buộc!' });
  }

  const member = await channelService.updateMemberPermission(id as string, targetUserId as string, canPost, userId);

  res.json({
    success: true,
    message: 'Cập nhật quyền thành công!',
    member,
  });
}));

// ==================== JOIN/LEAVE (WS-12) ====================

/**
 * POST /channels/:id/join - Join public channel
 */
channelRoutes.post('/channels/:id/join', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const member = await channelService.joinPublicChannel(id as string, userId);

  res.status(201).json({
    success: true,
    message: 'Đã tham gia channel!',
    member,
  });
}));

/**
 * POST /channels/:id/leave - Leave channel
 */
channelRoutes.post('/channels/:id/leave', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await channelService.leaveChannel(id as string, userId);

  res.json({
    success: true,
    message: 'Đã rời channel!',
  });
}));

// ==================== DEFAULT CHANNEL (WS-11) ====================

/**
 * PUT /channels/:id/default - Set channel as default
 */
channelRoutes.put('/channels/:id/default', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { isDefault } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (isDefault === undefined) {
    return res.status(400).json({ success: false, message: 'isDefault là bắt buộc!' });
  }

  const channel = await channelService.setDefaultChannel(id as string, isDefault, userId);
 
  res.json({
    success: true,
    message: isDefault ? 'Channel đã được đặt làm mặc định!' : 'Channel không còn là mặc định!',
    channel,
  });
}));

// ==================== PREFERENCES ====================

/**
 * PUT /channels/:id/preferences - Update member preferences (mute/pin)
 */
channelRoutes.put('/channels/:id/preferences', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { isMuted, isPinned } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const member = await channelService.updateMemberPreferences(id as string, userId, { isMuted, isPinned });

  res.json({
    success: true,
    message: 'Cập nhật preferences thành công!',
    member,
  });
}));
