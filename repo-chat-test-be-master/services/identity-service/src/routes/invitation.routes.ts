// services/identity-service/src/routes/invitation.routes.ts
// Migrated from userorg-service

import { Router } from 'express';
import type { Request, Response } from 'express';
import { invitationService } from '../services/invitation.service.js';
import { orgSettingsService } from '../services/org-settings.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const invitationRoutes = Router();

invitationRoutes.get('/validate/:token', asyncHandler(async (req: Request, res: Response) => {
  const invitation = await invitationService.validateInvitationToken(req.params.token as string);
  if (!invitation) return res.status(404).json({ success: false, message: 'Lời mời không hợp lệ!' });
  if (invitation.status !== 'PENDING') {
    return res.status(400).json({ success: false, message: `Lời mời đã ${invitation.status === 'ACCEPTED' ? 'được sử dụng' : invitation.status === 'EXPIRED' ? 'hết hạn' : 'bị thu hồi'}!`, status: invitation.status });
  }
  res.json({ success: true, invitation });
}));

invitationRoutes.post('/accept/:token', asyncHandler(async (req: Request, res: Response) => {
  const { name, password, gender } = req.body;
  if (!name || !password) return res.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ tên và mật khẩu!' });
  if (password.length < 6) return res.status(400).json({ success: false, message: 'Mật khẩu phải có ít nhất 6 ký tự!' });
  const result = await invitationService.acceptInvitation(req.params.token as string, { name, password, gender });
  res.json({ success: true, message: 'Chấp nhận lời mời thành công! Vui lòng đăng nhập.', ...result });
}));

invitationRoutes.post('/join/:token', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  
  await invitationService.joinViaInvitation(req.params.token as string, userId);
  res.json({ success: true, message: 'Tham gia thành công!' });
}));

invitationRoutes.post('/accept-body', asyncHandler(async (req: Request, res: Response) => {
  const { token, name, password, gender } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'Token là bắt buộc!' });
  if (!name || !password) return res.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ tên và mật khẩu!' });
  
  const result = await invitationService.acceptInvitation(token, { name, password, gender });
  res.json({ success: true, message: 'Chấp nhận lời mời thành công!', ...result });
}));

invitationRoutes.post('/join-body', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { token } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!token) return res.status(400).json({ success: false, message: 'Token là bắt buộc!' });
  
  await invitationService.joinViaInvitation(token, userId);
  res.json({ success: true, message: 'Tham gia thành công!' });
}));

invitationRoutes.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const userName = (req.headers['x-user-name'] as string) || 'Admin';
  const { email, type = 'USER', role, channelIds, workspaceId, expiryDays } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!email) return res.status(400).json({ success: false, message: 'Email không được để trống!' });

  if (type === 'GUEST') {
    const guestAllowed = await orgSettingsService.isGuestInviteAllowed();
    if (!guestAllowed) return res.status(403).json({ success: false, message: 'Tổ chức không cho phép mời guest!' });
  } else if (type === 'MANAGER') {
    const userRole = req.headers['x-user-role'] as string;
    if (userRole !== 'SUPER_ADMIN' && userRole !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền mời Workspace Manager!' });
    }
  } else {
    const userAllowed = await orgSettingsService.isUserInviteAllowed();
    if (!userAllowed) return res.status(403).json({ success: false, message: 'Tổ chức không cho phép mời user mới!' });
  }

  const invitation = await invitationService.createInvitation({ email, type, role, invitedBy: userId, inviterName: userName, channelIds, workspaceId, expiryDays });
  res.status(201).json({ success: true, message: 'Đã gửi lời mời thành công!', invitation });
}));

invitationRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const { status, type, workspaceId, page, limit } = req.query;
  const result = await invitationService.listInvitations({
    status: status as any, 
    type: type as any,
    workspaceId: workspaceId as string,
    page: page ? parseInt(page as string) : undefined, 
    limit: limit ? parseInt(limit as string) : undefined,
  });
  res.json({ success: true, ...result });
}));

invitationRoutes.post('/:id/resend', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await invitationService.resendInvitation(req.params.id as string);
  res.json({ success: true, message: 'Đã gửi lại lời mời!' });
}));

invitationRoutes.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  await invitationService.revokeInvitation(req.params.id as string, userId);
  res.json({ success: true, message: 'Đã thu hồi lời mời!' });
}));
