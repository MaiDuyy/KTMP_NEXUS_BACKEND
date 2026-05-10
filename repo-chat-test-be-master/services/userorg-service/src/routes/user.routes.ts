// services/userorg-service/src/routes/user.routes.ts

import { Router } from 'express';
import type { Request, Response } from 'express';
import { userService } from '../services/user.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const userRoutes = Router();

// ============= PROFILE ROUTES =============

/**
 * GET /profile - Lấy profile
 */
userRoutes.get('/profile', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const user = await userService.getProfile(userId);
  res.json({ success: true, user });
}));

/**
 * PUT /profile - Cập nhật profile
 */
userRoutes.put('/profile', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const user = await userService.updateProfile(userId, req.body);
  res.json({ success: true, message: 'Cập nhật thành công!', user });
}));

// ============= ACCOUNT ROUTES =============

/**
 * GET /account - Lấy thông tin chi tiết tài khoản
 */
userRoutes.get('/account', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const user = await userService.getAccountDetails(userId);
  res.json({ success: true, user });
}));

/**
 * PUT /account - Cập nhật tài khoản
 */
userRoutes.put('/account', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const user = await userService.updateAccount(userId, req.body);
  res.json({ success: true, message: 'Cập nhật thành công!', user });
}));

/**
 * PUT /status - Cập nhật status text
 */
userRoutes.put('/status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { status } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  // Validate status length
  if (status && status.length > 150) {
    return res.status(400).json({ success: false, message: 'Trạng thái không được quá 150 ký tự!' });
  }

  const result = await userService.updateStatus(userId, status);
  res.json({ success: true, message: 'Cập nhật trạng thái thành công!', ...result });
}));

/**
 * PUT /online-status - Cập nhật online/offline
 */
userRoutes.put('/online-status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { isOnline } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (typeof isOnline !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Trạng thái online không hợp lệ!' });
  }

  const result = await userService.updateOnlineStatus(userId, isOnline);
  res.json({
    success: true,
    message: `Đã ${isOnline ? 'online' : 'offline'}!`,
    ...result,
  });
}));

/**
 * POST /heartbeat - Heartbeat
 */
userRoutes.post('/heartbeat', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await userService.heartbeat(userId);
  res.json({ success: true });
}));

/**
 * GET /:id/status - Lấy trạng thái hoạt động user khác
 */
userRoutes.get('/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;

  const user = await userService.getUserActivityStatus(id);
  res.json({ success: true, user });
}));

// ============= DIRECTORY (ENTERPRISE APP) =============

/**
 * GET /directory - Trực tiếp tra cứu danh bạ (Search & DM)
 */
userRoutes.get('/directory', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const q = typeof req.query.q === 'string' ? req.query.q : '';

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const users = await userService.searchDirectory(q  , userId);
  res.json({ success: true, users });
}));

// ============= ADMIN ROUTES =============

/**
 * GET /batch - Lấy nhiều users theo IDs (phải đặt TRƯỚC /:id)
 */
userRoutes.get('/batch', asyncHandler(async (req: Request, res: Response) => {
  const ids = req.query.ids as string;
  if (!ids) return res.json({ success: true, users: [] });

  const idArray = ids.split(',').filter(Boolean);
  const users = await userService.getUsersByIds(idArray);
  res.json({ success: true, users });
}));

/**
 * GET / - Lấy danh sách users (Admin)
 */
userRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search, role } = req.query;

  const result = await userService.getAllUsers({
    page: page ? parseInt(page as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
    search: search as string,
    role: role as any,
  });

  res.json({ success: true, ...result });
}));

/**
 * GET /:id - Lấy user theo ID
 */
userRoutes.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;

  const user = await userService.getUserById(id);
  res.json({ success: true, user });
}));

/**
 * PUT /:id/role - Cập nhật role (Admin)
 */
userRoutes.put('/:id/role', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { role } = req.body;

  if (!role) {
    return res.status(400).json({ success: false, message: 'Role không được để trống!' });
  }

  const user = await userService.updateUserRole(id, role);
  res.json({ success: true, message: 'Cập nhật role thành công!', user });
}));

/**
 * DELETE /:id - Xóa user (Admin)
 */
userRoutes.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const id = req.params.id as string;

  await userService.deleteUser(id, userId);
  res.json({ success: true, message: 'Xóa tài khoản thành công!' });
}));

// ============= DEVICES ROUTES =============

/**
 * GET /devices - Lấy danh sách thiết bị
 */
userRoutes.get('/devices', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const devices = await userService.getLoggedInDevices(userId);
  res.json({ success: true, devices });
}));

/**
 * DELETE /devices/:deviceId - Đăng xuất thiết bị
 */
userRoutes.delete('/devices/:deviceId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const deviceId = req.params.deviceId as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await userService.logoutDevice(userId, deviceId);
  res.json({ success: true, message: 'Đăng xuất thiết bị thành công!' });
}));

// ============= MODULE 3: USER STATUS (USER-03) =============

/**
 * PUT /user-status - Cập nhật user status (ONLINE/AWAY/DND/INVISIBLE)
 */
userRoutes.put('/user-status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { userStatus } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const validStatuses = ['ONLINE', 'AWAY', 'DND', 'INVISIBLE'];
  if (!validStatuses.includes(userStatus)) {
    return res.status(400).json({ success: false, message: 'Trạng thái không hợp lệ!' });
  }

  const result = await userService.updateUserStatus(userId, userStatus);
  res.json({ success: true, message: 'Cập nhật trạng thái thành công!', user: result });
}));

// ============= MODULE 3: CUSTOM STATUS (USER-04) =============

/**
 * PUT /custom-status - Đặt custom status
 */
userRoutes.put('/custom-status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { text, emoji, expiryHours } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await userService.setCustomStatus(userId, { text, emoji, expiryHours });
  res.json({ success: true, message: 'Cập nhật custom status thành công!', user: result });
}));

/**
 * DELETE /custom-status - Xóa custom status
 */
userRoutes.delete('/custom-status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await userService.setCustomStatus(userId, { text: null });
  res.json({ success: true, message: 'Đã xóa custom status!', user: result });
}));

// ============= MODULE 3: SUSPENSION (USER-08) =============

import { suspensionService } from '../services/suspension.service.js';

/**
 * POST /:id/suspend - Đình chỉ user (Admin)
 */
userRoutes.post('/:id/suspend', asyncHandler(async (req: Request, res: Response) => {
  const currentUserId = req.headers['x-user-id'] as string;
  const id = req.params.id as string;
  const { reason } = req.body;

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!reason) {
    return res.status(400).json({ success: false, message: 'Vui lòng cung cấp lý do đình chỉ!' });
  }

  const result = await suspensionService.suspendUser(id, {
    reason,
    suspendedBy: currentUserId,
  });

  res.json({ success: true, message: 'Đình chỉ tài khoản thành công!', ...result });
}));

/**
 * POST /:id/unsuspend - Bỏ đình chỉ user (Admin)
 */
userRoutes.post('/:id/unsuspend', asyncHandler(async (req: Request, res: Response) => {
  const currentUserId = req.headers['x-user-id'] as string;
  const id = req.params.id as string;

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await suspensionService.unsuspendUser(id, currentUserId);
  res.json({ success: true, message: 'Khôi phục tài khoản thành công!', ...result });
}));

/**
 * GET /suspended - Danh sách users bị đình chỉ (Admin)
 */
userRoutes.get('/admin/suspended', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query;

  const result = await suspensionService.listSuspendedUsers({
    page: page ? parseInt(page as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
  });

  res.json({ success: true, ...result });
}));

// ============= MODULE 3: ENHANCED DELETION (USER-09) =============

/**
 * DELETE /:id - Xóa user với tùy chọn anonymize (Admin)
 * Query: ?anonymize=true để anonymize thay vì xóa
 */
userRoutes.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const currentUserId = req.headers['x-user-id'] as string;
  const id = req.params.id as string;
  const { anonymize } = req.query;

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await userService.deleteUserEnhanced(id, currentUserId, {
    anonymize: anonymize === 'true',
  });

  const message = anonymize === 'true' 
    ? 'Đã anonymize tài khoản thành công!' 
    : 'Xóa tài khoản thành công!';

  res.json({ success: true, message, ...result });
}));
