// services/group-service/src/routes/workspace.routes.ts
// Workspace management endpoints

import { Router } from 'express';
import type { Request, Response } from 'express';
import { workspaceService } from '../services/workspace.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { WorkspaceRole } from '@prisma/client';

export const workspaceRoutes = Router();

/**
 * POST / - Create workspace (WS-01)
 */
workspaceRoutes.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { name, description, icon, slug, isPublic, allowGuestAccess } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!name) {
    return res.status(400).json({ success: false, message: 'Tên workspace là bắt buộc!' });
  }

  const workspace = await workspaceService.createWorkspace(
    { name, description, icon, slug, isPublic, allowGuestAccess },
    userId
  );

  res.status(201).json({
    success: true,
    message: 'Tạo workspace thành công!',
    workspace,
  });
}));

/**
 * GET / - List my workspaces
 */
workspaceRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const workspaces = await workspaceService.getUserWorkspaces(userId);

  res.json({
    success: true,
    workspaces,
  });
}));

/**
 * GET /:id - Get workspace details
 */
workspaceRoutes.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const workspace = await workspaceService.getWorkspace(id as string, userId);

  res.json({
    success: true,
    workspace,
  });
}));

/**
 * PUT /:id - Update workspace (WS-02)
 */
workspaceRoutes.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { name, description, icon, isPublic, allowGuestAccess } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const workspace = await workspaceService.updateWorkspace(
    id as string,
    { name, description, icon, isPublic, allowGuestAccess },
    userId
  );

  res.json({
    success: true,
    message: 'Cập nhật workspace thành công!',
    workspace,
  });
}));

/**
 * DELETE /:id - Delete workspace
 */
workspaceRoutes.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await workspaceService.deleteWorkspace(id as string, userId);

  res.json({
    success: true,
    message: 'Xóa workspace thành công!',
  });
}));

// ==================== MEMBER MANAGEMENT (WS-09) ====================

/**
 * GET /:id/members - List workspace members
 */
workspaceRoutes.get('/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { page, limit } = req.query;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await workspaceService.getMembers(id as string, {
    page: page ? parseInt(page as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
  });

  res.json({
    success: true,
    ...result,
  });
}));

/**
 * POST /:id/members - Add member
 */
workspaceRoutes.post('/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { targetUserId, role } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!targetUserId) {
    return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
  }

  const member = await workspaceService.addMember(
    id as string,
    targetUserId,
    (role as WorkspaceRole) || 'MEMBER',
    userId
  );

  res.status(201).json({
    success: true,
    message: 'Thêm thành viên thành công!',
    member,
  });
}));

/**
 * DELETE /:id/members/:userId - Remove member
 */
workspaceRoutes.delete('/:id/members/:targetUserId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id, targetUserId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await workspaceService.removeMember(id as string, targetUserId as string, userId);

  res.json({
    success: true,
    message: userId === targetUserId ? 'Đã rời workspace!' : 'Đã xóa thành viên!',
  });
}));

/**
 * PUT /:id/members/:userId - Update member role
 */
workspaceRoutes.put('/:id/members/:targetUserId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id, targetUserId } = req.params;
  const { role } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!role) {
    return res.status(400).json({ success: false, message: 'role là bắt buộc!' });
  }

  const member = await workspaceService.updateMemberRole(id as string, targetUserId as string, role as WorkspaceRole, userId);

  res.json({
    success: true,
    message: 'Cập nhật role thành công!',
    member,
  });
}));

/**
 * POST /:id/leave - Leave workspace
 */
workspaceRoutes.post('/:id/leave', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await workspaceService.removeMember(id as string, userId, userId);

  res.json({
    success: true,
    message: 'Đã rời workspace!',
  });
}));
