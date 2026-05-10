// services/identity-service/src/routes/org-settings.routes.ts
// Migrated from userorg-service

import { Router } from 'express';
import type { Request, Response } from 'express';
import { orgSettingsService } from '../services/org-settings.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const orgSettingsRoutes = Router();

orgSettingsRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const settings = await orgSettingsService.getSettings();
  res.json({ success: true, settings });
}));

orgSettingsRoutes.put('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const settings = await orgSettingsService.updateSettings(req.body, userId);
  res.json({ success: true, message: 'Cập nhật cài đặt tổ chức thành công!', settings });
}));

orgSettingsRoutes.get('/company-name', asyncHandler(async (_req: Request, res: Response) => {
  const companyName = await orgSettingsService.getCompanyName();
  res.json({ success: true, companyName });
}));

orgSettingsRoutes.get('/invite-settings', asyncHandler(async (_req: Request, res: Response) => {
  const settings = await orgSettingsService.getSettings();
  res.json({ success: true, allowGuestInvite: settings.allowGuestInvite, allowUserInvite: settings.allowUserInvite, defaultUserRole: settings.defaultUserRole });
}));
