// services/userorg-service/src/routes/org-settings.routes.ts
// USER-12: Organization Settings

import { Router } from 'express';
import type { Request, Response } from 'express';
import { orgSettingsService } from '../services/org-settings.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const orgSettingsRoutes = Router();

/**
 * GET / - Get organization settings
 */
orgSettingsRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const settings = await orgSettingsService.getSettings();
  res.json({ success: true, settings });
}));

/**
 * PUT / - Update organization settings (Super Admin only)
 */
orgSettingsRoutes.put('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  // Note: Permission check should be done via middleware or RBAC service
  // For now, we rely on the header to indicate super admin

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  }

  const {
    companyName,
    logoUrl,
    timezone,
    language,
    allowGuestInvite,
    allowUserInvite,
    defaultUserRole,
    messageRetentionDays,
    fileRetentionDays,
  } = req.body;

  const settings = await orgSettingsService.updateSettings(
    {
      companyName,
      logoUrl,
      timezone,
      language,
      allowGuestInvite,
      allowUserInvite,
      defaultUserRole,
      messageRetentionDays,
      fileRetentionDays,
    },
    userId
  );

  res.json({ 
    success: true, 
    message: 'Cập nhật cài đặt tổ chức thành công!',
    settings,
  });
}));

/**
 * GET /company-name - Get company name (public helper)
 */
orgSettingsRoutes.get('/company-name', asyncHandler(async (_req: Request, res: Response) => {
  const companyName = await orgSettingsService.getCompanyName();
  res.json({ success: true, companyName });
}));

/**
 * GET /invite-settings - Get invitation settings
 */
orgSettingsRoutes.get('/invite-settings', asyncHandler(async (_req: Request, res: Response) => {
  const settings = await orgSettingsService.getSettings();
  res.json({ 
    success: true, 
    allowGuestInvite: settings.allowGuestInvite,
    allowUserInvite: settings.allowUserInvite,
    defaultUserRole: settings.defaultUserRole,
  });
}));
