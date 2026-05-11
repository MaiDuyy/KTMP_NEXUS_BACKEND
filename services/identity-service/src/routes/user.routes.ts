// services/identity-service/src/routes/user.routes.ts
// Migrated from userorg-service

import { Router } from 'express';
import type { Request, Response } from 'express';
import { userService } from '../services/user.service.js';
import { suspensionService } from '../services/suspension.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const userRoutes = Router();

// ============= PROFILE =============
userRoutes.get('/profile', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const user = await userService.getProfile(userId);
  res.json({ success: true, user });
}));

userRoutes.put('/profile', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const user = await userService.updateProfile(userId, req.body);
  res.json({ success: true, message: 'Cập nhật thành công!', user });
}));

// ============= ACCOUNT =============
userRoutes.get('/account', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const user = await userService.getAccountDetails(userId);
  res.json({ success: true, user });
}));

userRoutes.put('/account', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const user = await userService.updateAccount(userId, req.body);
  res.json({ success: true, message: 'Cập nhật thành công!', user });
}));

// ============= STATUS =============
userRoutes.put('/status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await userService.updateStatus(userId, req.body.status);
  res.json({ success: true, message: 'Cập nhật trạng thái thành công!', ...result });
}));

userRoutes.put('/online-status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { isOnline } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (typeof isOnline !== 'boolean') return res.status(400).json({ success: false, message: 'Trạng thái online không hợp lệ!' });
  const result = await userService.updateOnlineStatus(userId, isOnline);
  res.json({ success: true, message: `Đã ${isOnline ? 'online' : 'offline'}!`, ...result });
}));

userRoutes.post('/heartbeat', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await userService.heartbeat(userId);
  res.json({ success: true });
}));

userRoutes.put('/user-status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const validStatuses = ['ONLINE', 'AWAY', 'DND', 'INVISIBLE'];
  if (!validStatuses.includes(req.body.userStatus)) return res.status(400).json({ success: false, message: 'Trạng thái không hợp lệ!' });
  const result = await userService.updateUserStatus(userId, req.body.userStatus);
  res.json({ success: true, message: 'Cập nhật trạng thái thành công!', user: result });
}));

userRoutes.put('/custom-status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await userService.setCustomStatus(userId, req.body);
  res.json({ success: true, message: 'Cập nhật custom status thành công!', user: result });
}));

userRoutes.delete('/custom-status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const result = await userService.setCustomStatus(userId, { text: null });
  res.json({ success: true, message: 'Đã xóa custom status!', user: result });
}));

// ============= DIRECTORY =============
userRoutes.get('/directory', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId)
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  const users = await userService.searchDirectory(q, userId, workspaceId);
  res.json({ success: true, users });
}));

// ============= ADMIN =============
userRoutes.get('/batch', asyncHandler(async (req: Request, res: Response) => {
  const ids = req.query.ids as string;
  if (!ids) return res.json({ success: true, users: [] });
  const users = await userService.getUsersByIds(ids.split(',').filter(Boolean));
  res.json({ success: true, users });
}));

userRoutes.get('/admin/suspended', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query;
  const result = await suspensionService.listSuspendedUsers({
    page: page ? parseInt(page as string) : undefined, limit: limit ? parseInt(limit as string) : undefined,
  });
  res.json({ success: true, ...result });
}));

userRoutes.get('/devices', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const devices = await userService.getLoggedInDevices(userId);
  res.json({ success: true, devices });
}));

userRoutes.delete('/devices/:deviceId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await userService.logoutDevice(userId, req.params.deviceId as string);
  res.json({ success: true, message: 'Đăng xuất thiết bị thành công!' });
}));

userRoutes.get('/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.getUserActivityStatus(req.params.id as string);
  res.json({ success: true, user });
}));

userRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search, role } = req.query;
  const result = await userService.getAllUsers({
    page: page ? parseInt(page as string) : undefined, limit: limit ? parseInt(limit as string) : undefined,
    search: search as string, role: role as any,
  });
  res.json({ success: true, ...result });
}));

userRoutes.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.getUserById(req.params.id as string);
  res.json({ success: true, user });
}));

userRoutes.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const currentUserId = req.headers['x-user-id'] as string;
  if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const user = await userService.updateUserAdmin(req.params.id as string, req.body, currentUserId);
  res.json({ success: true, message: 'Cập nhật người dùng thành công!', user });
}));

userRoutes.put('/:id/role', asyncHandler(async (req: Request, res: Response) => {
  if (!req.body.role) return res.status(400).json({ success: false, message: 'Role không được để trống!' });
  const user = await userService.updateUserRole(req.params.id as string, req.body.role);
  res.json({ success: true, message: 'Cập nhật role thành công!', user });
}));

userRoutes.post('/:id/suspend', asyncHandler(async (req: Request, res: Response) => {
    const currentUserId = req.headers['x-user-id'] as string;
    if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    if (!req.body.reason) return res.status(400).json({ success: false, message: 'Vui lòng cung cấp lý do đình chỉ!' });
    const result = await suspensionService.suspendUser(req.params.id as string, { reason: req.body.reason, suspendedBy: currentUserId });
    res.json({ success: true, message: 'Đã khóa tài khoản người dùng', ...result });
}));

userRoutes.post('/:id/unsuspend', asyncHandler(async (req: Request, res: Response) => {
    const currentUserId = req.headers['x-user-id'] as string;
    if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    const { reason } = req.body;
    const result = await suspensionService.unsuspendUser(req.params.id as string, { 
      reason: reason || 'Mở khóa bởi Admin', 
      unsuspendedBy: currentUserId 
    });
    res.json({ success: true, message: 'Đã mở khóa tài khoản người dùng', ...result });
}));

userRoutes.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const currentUserId = req.headers['x-user-id'] as string;
  if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const { anonymize } = req.query;
  const result = await userService.deleteUserEnhanced(req.params.id as string, currentUserId, { anonymize: anonymize === 'true' });
  res.json({ success: true, message: anonymize === 'true' ? 'Đã anonymize tài khoản thành công!' : 'Xóa tài khoản thành công!', ...result });
}));
