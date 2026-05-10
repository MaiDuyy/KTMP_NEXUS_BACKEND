import { Router } from 'express';
import type { Request, Response } from 'express';
import { userService } from '../services/user.service.js';
import { suspensionService } from '../services/suspension.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const adminRoutes = Router();

// ============= STATISTICS =============
adminRoutes.get('/stats', asyncHandler(async (req: Request, res: Response) => {
  const stats = await userService.getAdminStats();
  res.json({ success: true, ...stats });
}));

// ============= BROADCAST =============
adminRoutes.post('/broadcast', asyncHandler(async (req: Request, res: Response) => {
  const currentUserId = req.headers['x-user-id'] as string;
  const { title, body, type } = req.body;
  
  if (!title || !body) {
    return res.status(400).json({ success: false, message: 'Tiêu đề và nội dung không được để trống!' });
  }

  await userService.broadcast(currentUserId, { title, body, type: type || 'ANNOUNCEMENT' });
  res.json({ success: true, message: 'Thông báo đã được gửi tới toàn bộ hệ thống!' });
}));

// ============= USER MANAGEMENT =============

// List users (paginated + search)
adminRoutes.get('/users', asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const search = req.query.search as string;
  const role = req.query.role as string;
  const status = req.query.status as string;

  const result = await userService.getAllUsers({ 
    page, 
    limit, 
    search, 
    role,
    isSuspended: status === 'suspended' ? true : status === 'active' ? false : undefined
  });
  res.json({ success: true, ...result });
}));

// Update user status (Active/Suspended)
adminRoutes.patch('/users/:userId/status', asyncHandler(async (req: Request, res: Response) => {
  const adminId = req.headers['x-user-id'] as string;
  const { userId } = req.params;
  const { isSuspended, reason } = req.body;

  if (isSuspended) {
    await suspensionService.suspendUser(userId as string, { reason: reason || 'Bị đình chỉ bởi Admin', suspendedBy: adminId });
  } else {
    await suspensionService.unsuspendUser(userId as string, { reason: reason || 'Mở khóa bởi Admin', unsuspendedBy: adminId });
  }

  res.json({ 
    success: true, 
    message: isSuspended ? 'Đã khóa tài khoản người dùng' : 'Đã mở khóa tài khoản người dùng' 
  });
}));

// Update user role
adminRoutes.patch('/users/:userId/role', asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { role } = req.body;

  await userService.updateUserRole(userId as string, role);
  res.json({ success: true, message: 'Đã cập nhật quyền người dùng' });
}));

// Delete user
adminRoutes.delete('/users/:userId', asyncHandler(async (req: Request, res: Response) => {
  const adminId = req.headers['x-user-id'] as string;
  const { userId } = req.params;
  
  await userService.deleteUserEnhanced(userId as string, adminId, { anonymize: false });
  res.json({ success: true, message: 'Đã xóa người dùng khỏi hệ thống' });
}));
// Update organization quota
adminRoutes.patch('/organizations/:orgId/quota', asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = req.params;
  const { maxWorkspaces } = req.body;

  if (maxWorkspaces === undefined) {
    return res.status(400).json({ success: false, message: 'maxWorkspaces là bắt buộc!' });
  }

  await userService.updateOrganizationQuota(orgId as string, parseInt(maxWorkspaces as string));
  res.json({ success: true, message: 'Đã cập nhật giới hạn Workspace cho tổ chức' });
}));

// List organizations
adminRoutes.get('/organizations', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search } = req.query;
  const result = await userService.getAllOrganizations({
    page: page ? parseInt(page as string) : 1,
    limit: limit ? parseInt(limit as string) : 10,
    search: search as string,
  });
  res.json({ success: true, ...result });
}));

// Update user workspace quota
adminRoutes.patch('/users/:userId/quota', asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { maxWorkspaces } = req.body;

  if (maxWorkspaces === undefined) {
    return res.status(400).json({ success: false, message: 'maxWorkspaces là bắt buộc!' });
  }

  await userService.updateUserQuota(userId as string, parseInt(maxWorkspaces as string));
  res.json({ success: true, message: 'Đã cập nhật giới hạn Workspace cho người dùng' });
}));
