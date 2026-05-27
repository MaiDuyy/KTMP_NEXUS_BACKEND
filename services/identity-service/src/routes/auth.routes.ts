// services/identity-service/src/routes/auth.routes.ts
// Migrated from auth-service — import paths updated

import { Router } from 'express';
import type { Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { authService } from '../services/auth.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { signUpSchema, signInSchema, verifyOtpSchema, resendOtpSchema, registerOrgSchema, createOrgSchema } from '../schemas/auth.schema.js';
import { authConfig } from '../config/auth.config.js';

export const authRoutes = Router();

function validateBody<T>(schema: ZodSchema<T>, body: unknown): T { return schema.parse(body); }
function formatZodError(error: ZodError): string { return error.errors.map(e => e.message).join(', '); }

const COOKIE_OPTIONS = authConfig.cookie.options;

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(authConfig.cookie.accessTokenName, accessToken, { ...COOKIE_OPTIONS, maxAge: authConfig.cookie.accessTokenMaxAge });
  res.cookie(authConfig.cookie.refreshTokenName, refreshToken, { ...COOKIE_OPTIONS, maxAge: authConfig.cookie.refreshTokenMaxAge });
}

function clearAuthCookies(res: Response) {
  res.clearCookie(authConfig.cookie.accessTokenName, COOKIE_OPTIONS);
  res.clearCookie(authConfig.cookie.refreshTokenName, COOKIE_OPTIONS);
}

authRoutes.post('/create-organization', asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    
    const data = validateBody(createOrgSchema, req.body);
    const result = await authService.createOrganization(userId, data);
    res.status(201).json({ success: true, message: 'Tạo tổ chức thành công!', ...result });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ success: false, message: formatZodError(error) });
    throw error;
  }
}));

authRoutes.post('/register-organization', asyncHandler(async (req: Request, res: Response) => {
  try {
    const data = validateBody(registerOrgSchema, req.body);
    const result = await authService.registerOrganization(data);
    res.status(201).json({ success: true, message: 'Đăng ký tổ chức thành công!', ...result });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ success: false, message: formatZodError(error) });
    throw error;
  }
}));

authRoutes.post('/signup', asyncHandler(async (req: Request, res: Response) => {
  return res.status(403).json({
    success: false,
    message: 'Chức năng tự đăng ký tài khoản đã bị tắt đối với hệ thống doanh nghiệp nội bộ để đảm bảo bảo mật và kiểm soát thành viên. Vui lòng liên hệ Quản trị viên (Admin) hoặc nhân sự (HR) để được cấp tài khoản.',
  });
}));

authRoutes.post('/verify-otp', asyncHandler(async (req: Request, res: Response) => {
  try {
    const data = validateBody(verifyOtpSchema, req.body);
    await authService.verifyOtp(data.email, data.code, 'VERIFY_EMAIL');
    res.json({ success: true, message: 'Xác thực email thành công! Bạn có thể đăng nhập.' });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ success: false, message: formatZodError(error) });
    throw error;
  }
}));

authRoutes.post('/resend-otp', asyncHandler(async (req: Request, res: Response) => {
  try {
    const data = validateBody(resendOtpSchema, req.body);
    const result = await authService.resendVerificationOtp(data.email);
    if (!result.success) return res.status(429).json({ success: false, message: result.message, resendAvailableIn: result.resendAvailableIn });
    res.json({ success: true, message: 'OTP đã được gửi lại. Vui lòng kiểm tra email.' });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ success: false, message: formatZodError(error) });
    throw error;
  }
}));

authRoutes.post('/signin', asyncHandler(async (req: Request, res: Response) => {
  const { email, password, deviceId, deviceName, platform } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Vui lòng nhập email và mật khẩu!' });

  const result = await authService.signIn({ email, password, deviceId, deviceName, platform, ipAddress: req.ip });
  setAuthCookies(res, result.accessToken, result.refreshToken);
  res.json({ success: true, message: 'Đăng nhập thành công!', user: result.user, accessToken: result.accessToken, refreshToken: result.refreshToken, permissions: result.permissions || [], roles: result.roles || [] });
}));

authRoutes.post('/signin-phone', asyncHandler(async (req: Request, res: Response) => {
  const { number, password, deviceId, deviceName, platform } = req.body;
  if (!number || !password) return res.status(400).json({ success: false, message: 'Vui lòng nhập số điện thoại và mật khẩu!' });

  const result = await authService.signInWithPhone({ number, password, deviceId, deviceName, platform, ipAddress: req.ip });
  setAuthCookies(res, result.accessToken, result.refreshToken);
  res.json({ success: true, message: 'Đăng nhập thành công!', user: result.user, accessToken: result.accessToken, refreshToken: result.refreshToken, permissions: result.permissions || [], roles: result.roles || [] });
}));

authRoutes.post('/signout', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { deviceId } = req.body;
  if (userId) await authService.signOut(userId, deviceId);
  clearAuthCookies(res);
  res.json({ success: true, message: 'Đăng xuất thành công!' });
}));

authRoutes.post('/refresh-token', asyncHandler(async (req: Request, res: Response) => {
  let refreshToken = req.cookies?.[authConfig.cookie.refreshTokenName] || req.body.refreshToken;
  if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token không được để trống!' });
  const tokens = await authService.refreshToken(refreshToken);
  setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
  res.json({ success: true, message: 'Làm mới token thành công!', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
}));

authRoutes.put('/change-password', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { currentPassword, newPassword } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới!' });
  if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'Mật khẩu mới phải có ít nhất 6 ký tự!' });
  await authService.changePassword(userId, currentPassword, newPassword);
  clearAuthCookies(res);
  res.json({ success: true, message: 'Đổi mật khẩu thành công! Vui lòng đăng nhập lại.' });
}));

authRoutes.get('/check', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ authenticated: false, message: 'Chưa đăng nhập!' });
  const user = await authService.checkAuth(userId);
  res.json({ authenticated: true, user });
}));

authRoutes.get('/me', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
  const user = await authService.getUserById(userId);
  if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
  res.json({ success: true, user });
}));
