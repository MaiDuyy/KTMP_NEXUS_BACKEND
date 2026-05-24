// services/messaging-service/src/routes/workspace.routes.ts
// Workspace routes — migrated from group-service

import { Router } from 'express';
import type { Request, Response } from 'express';
import { workspaceService } from '../services/workspace.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { WorkspaceRole } from '@prisma/client';

export const workspaceRoutes = Router();

workspaceRoutes.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { name, description, icon, slug, isPublic, allowGuestAccess, departmentId } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!name) return res.status(400).json({ success: false, message: 'Tên workspace là bắt buộc!' });
  const workspace = await workspaceService.createWorkspace({ name, description, icon, slug, isPublic, allowGuestAccess, departmentId }, userId);
  res.status(201).json({ success: true, message: 'Tạo workspace thành công!', workspace });
}));

workspaceRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { departmentId } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

  if (departmentId && typeof departmentId === 'string') {
    // Return workspaces filtered by department
    const workspaces = await workspaceService.getWorkspacesByDepartment(departmentId, userId);
    return res.json({ success: true, workspaces });
  }

  const workspaces = await workspaceService.getUserWorkspaces(userId);
  res.json({ success: true, workspaces });
}));

workspaceRoutes.get('/dissolved', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const workspaces = await workspaceService.getDissolvedWorkspaces(userId);
  res.json({ success: true, workspaces });
}));

workspaceRoutes.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const workspace = await workspaceService.getWorkspace(id as string, userId);
  res.json({ success: true, workspace });
}));

workspaceRoutes.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { name, description, icon, isPublic, allowGuestAccess, departmentId } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const workspace = await workspaceService.updateWorkspace(id as string, { name, description, icon, isPublic, allowGuestAccess, departmentId }, userId);
  res.json({ success: true, message: 'Cập nhật workspace thành công!', workspace });
}));

workspaceRoutes.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await workspaceService.deleteWorkspace(id as string, userId);
  res.json({ success: true, message: 'Xóa workspace thành công!' });
}));

workspaceRoutes.get('/:id/stats', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await workspaceService.getWorkspaceStats(id as string, userId);
  res.json(result);
}));

// Member management
workspaceRoutes.get('/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { page, limit } = req.query;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await workspaceService.getMembers(id as string, {
    page: page ? parseInt(page as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
  });
  res.json({ success: true, ...result });
}));

workspaceRoutes.post('/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { targetUserId, role } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!targetUserId) return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
  const member = await workspaceService.addMember(id as string, targetUserId, (role as WorkspaceRole) || 'WORKSPACE_MEMBER', userId);
  res.status(201).json({ success: true, message: 'Thêm thành viên thành công!', member });
}));

workspaceRoutes.delete('/:id/members/:targetUserId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id, targetUserId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await workspaceService.removeMember(id as string, targetUserId as string, userId);
  res.json({ success: true, message: userId === targetUserId ? 'Đã rời workspace!' : 'Đã xóa thành viên!' });
}));

workspaceRoutes.put('/:id/members/:targetUserId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id, targetUserId } = req.params;
  const { role } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!role) return res.status(400).json({ success: false, message: 'role là bắt buộc!' });
  const member = await workspaceService.updateMemberRole(id as string, targetUserId as string, role as WorkspaceRole, userId);
  res.json({ success: true, message: 'Cập nhật role thành công!', member });
}));
workspaceRoutes.post('/:id/transfer-ownership', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { targetUserId } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!targetUserId) return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
  const workspace = await workspaceService.transferOwnership(id as string, targetUserId, userId);
  res.json({ success: true, message: 'Chuyển quyền sở hữu thành công!', workspace });
}));

workspaceRoutes.post('/:id/leave', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await workspaceService.removeMember(id as string, userId, userId);
  res.json({ success: true, message: 'Đã rời workspace!' });
}));

// ================= INVITATION ROUTES =================

/**
 * Gửi lời mời mới (Chỉ OWNER/ADMIN)
 */
workspaceRoutes.post('/:id/invites', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  const { email, role } = req.body;
  
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!email) return res.status(400).json({ success: false, message: 'Email là bắt buộc!' });

  const result = await workspaceService.inviteMember(id as string, userId, email, role as WorkspaceRole);
  res.status(201).json(result);
}));

/**
 * Kiểm tra Token (Không cần đăng nhập để check, nhưng cần để join)
 */
workspaceRoutes.get('/invites/validate/:token', asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.params;
  const invite = await workspaceService.validateInviteToken(token as string);
  res.json({ success: true, invite });
}));

/**
 * Chấp nhận lời mời (Cần đăng nhập)
 */
workspaceRoutes.post('/invites/accept', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { token } = req.body;

  if (!userId) return res.status(401).json({ success: false, message: 'Vui lòng đăng nhập để tham gia Workspace!' });
  if (!token) return res.status(400).json({ success: false, message: 'Token là bắt buộc!' });

  const result = await workspaceService.acceptInvite(token as string, userId);
  res.json(result);
}));

/**
 * Từ chối lời mời
 */
workspaceRoutes.post('/invites/reject', asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'Token là bắt buộc!' });

  const result = await workspaceService.rejectInvite(token as string);
  res.json(result);
}));

/**
 * Lấy danh sách lời mời (Chỉ OWNER/ADMIN)
 */
workspaceRoutes.get('/:id/invites', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

  const invites = await workspaceService.getWorkspaceInvites(id as string, userId);
  res.json({ success: true, invites });
}));

/**
 * Hủy lời mời (Chỉ OWNER/ADMIN)
 */
workspaceRoutes.delete('/invites/:inviteId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { inviteId } = req.params;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

  const result = await workspaceService.cancelInvite(inviteId as string, userId);
  res.json(result);
}));
