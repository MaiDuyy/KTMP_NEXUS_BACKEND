// services/userorg-service/src/routes/invitation.routes.ts
// USER-07: User Invitation, USER-10: Guest Invitation

import { Router } from 'express';
import type { Request, Response } from 'express';
import { invitationService } from '../services/invitation.service.js';
import { orgSettingsService } from '../services/org-settings.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const invitationRoutes = Router();

// ============= PUBLIC ROUTES =============

/**
 * GET /validate/:token - Validate invitation token (public)
 */
invitationRoutes.get('/validate/:token', asyncHandler(async (req: Request, res: Response) => {
  const token = req.params.token as string;

  const invitation = await invitationService.validateToken(token);
  
  if (!invitation) {
    return res.status(404).json({ success: false, message: 'Lời mời không hợp lệ!' });
  }

  if (invitation.status !== 'pending') {
    return res.status(400).json({ 
      success: false, 
      message: `Lời mời đã ${invitation.status === 'accepted' ? 'được sử dụng' : invitation.status === 'expired' ? 'hết hạn' : 'bị thu hồi'}!`,
      status: invitation.status,
    });
  }

  res.json({ 
    success: true, 
    invitation: {
      email: invitation.email,
      type: invitation.type,
      inviterName: invitation.inviterName,
      expiresAt: invitation.expiresAt,
    },
  });
}));

/**
 * POST /accept/:token - Accept invitation and create account (public)
 */
invitationRoutes.post('/accept/:token', asyncHandler(async (req: Request, res: Response) => {
  const token = req.params.token as string;
  const { name, password, gender } = req.body;

  if (!name || !password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Vui lòng điền đầy đủ tên và mật khẩu!' 
    });
  }

  if (password.length < 6) {
    return res.status(400).json({ 
      success: false, 
      message: 'Mật khẩu phải có ít nhất 6 ký tự!' 
    });
  }

  const result = await invitationService.acceptInvitation(token, { name, password, gender });
  res.json({ 
    success: true, 
    message: 'Chấp nhận lời mời thành công! Vui lòng đăng nhập.',
    ...result,
  });
}));

// ============= AUTHENTICATED ROUTES =============

/**
 * POST / - Create new invitation (Admin/Manager)
 */
invitationRoutes.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const userName = req.headers['x-user-name'] as string || 'Admin';
  const { email, type = 'USER', channelIds, workspaceId, expiryDays } = req.body;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email không được để trống!' });
  }

  // Check if invitation type is allowed
  if (type === 'GUEST') {
    const guestAllowed = await orgSettingsService.isGuestInviteAllowed();
    if (!guestAllowed) {
      return res.status(403).json({ 
        success: false, 
        message: 'Tổ chức không cho phép mời guest!' 
      });
    }
  } else {
    const userAllowed = await orgSettingsService.isUserInviteAllowed();
    if (!userAllowed) {
      return res.status(403).json({ 
        success: false, 
        message: 'Tổ chức không cho phép mời user mới!' 
      });
    }
  }

  const invitation = await invitationService.createInvitation({
    email,
    type,
    invitedBy: userId,
    inviterName: userName,
    channelIds,
    workspaceId,
    expiryDays,
  });

  res.status(201).json({ 
    success: true, 
    message: 'Đã gửi lời mời thành công!',
    invitation,
  });
}));

/**
 * GET / - List invitations (Admin)
 */
invitationRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { status, type, page, limit } = req.query;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const result = await invitationService.listInvitations({
    status: status as 'pending' | 'accepted' | 'expired' | 'revoked' | undefined,
    type: type as 'USER' | 'GUEST' | undefined,
    page: page ? parseInt(page as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
  });

  res.json({ success: true, ...result });
}));

/**
 * POST /:id/resend - Resend invitation email
 */
invitationRoutes.post('/:id/resend', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const id = req.params.id as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await invitationService.resendInvitation(id);
  res.json({ success: true, message: 'Đã gửi lại lời mời!' });
}));

/**
 * DELETE /:id - Revoke invitation
 */
invitationRoutes.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const id = req.params.id as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  await invitationService.revokeInvitation(id, userId);
  res.json({ success: true, message: 'Đã thu hồi lời mời!' });
}));
