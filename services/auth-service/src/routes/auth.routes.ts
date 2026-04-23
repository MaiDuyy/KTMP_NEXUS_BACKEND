// services/auth-service/src/routes/auth.routes.ts
// Migrate từ src/routes/auth.routes.ts với tất cả endpoints

import { Router } from 'express';
import type { Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { authService } from '../services/auth.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  signUpSchema,
  signInSchema,
  signInPhoneSchema,
  verifyOtpSchema,
  resendOtpSchema,
  changePasswordSchema,
} from '../schemas/auth.schema.js';

export const authRoutes = Router();

// Validation helper
function validateBody<T>(schema: ZodSchema<T>, body: unknown): T {
  return schema.parse(body);
}

function formatZodError(error: ZodError): string {
  return error.errors.map(e => e.message).join(', ');
}

// ============= Cookie Helpers =============

import { authConfig } from '../config/auth.config.js';

const COOKIE_OPTIONS = authConfig.cookie.options;

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(authConfig.cookie.accessTokenName, accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: authConfig.cookie.accessTokenMaxAge,
  });
  res.cookie(authConfig.cookie.refreshTokenName, refreshToken, {
    ...COOKIE_OPTIONS,
    maxAge: authConfig.cookie.refreshTokenMaxAge,
  });
}

function clearAuthCookies(res: Response) {
  res.clearCookie(authConfig.cookie.accessTokenName, COOKIE_OPTIONS);
  res.clearCookie(authConfig.cookie.refreshTokenName, COOKIE_OPTIONS);
}

// ============= ROUTES =============

/**
 * POST /signup - Đăng ký tài khoản mới
 */
authRoutes.post('/signup', asyncHandler(async (req: Request, res: Response) => {
  try {
    const data = validateBody(signUpSchema, req.body);
    
    const user = await authService.signUp({
      name: data.name,
      email: data.email,
      number: data.number,
      password: data.password,
      gender: data.gender,
      birthDate: data.birthDate,
      location: data.location,
      role : data.role
    });

    res.status(201).json({
      success: true,
      message: 'Đăng ký thành công! Vui lòng kiểm tra email để xác thực tài khoản.',
      user,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        success: false,
        message: formatZodError(error),
      });
    }
    throw error;
  }
}));

/**
 * POST /verify-otp - Xác thực OTP
 */
authRoutes.post('/verify-otp', asyncHandler(async (req: Request, res: Response) => {
  try {
    const data = validateBody(verifyOtpSchema, req.body);
    
    await authService.verifyOtp(data.email, data.code, 'VERIFY_EMAIL');

    res.json({
      success: true,
      message: 'Xác thực email thành công! Bạn có thể đăng nhập.',
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        success: false,
        message: formatZodError(error),
      });
    }
    throw error;
  }
}));

/**
 * POST /resend-otp - Gửi lại OTP
 */
authRoutes.post('/resend-otp', asyncHandler(async (req: Request, res: Response) => {
  try {
    const data = validateBody(resendOtpSchema, req.body);
    
    const result = await authService.resendVerificationOtp(data.email);

    if (!result.success) {
      return res.status(429).json({
        success: false,
        message: result.message,
        resendAvailableIn: result.resendAvailableIn,
      });
    }

    res.json({
      success: true,
      message: 'OTP đã được gửi lại. Vui lòng kiểm tra email.',
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        success: false,
        message: formatZodError(error),
      });
    }
    throw error;
  }
}));

/**
 * POST /signin - Đăng nhập bằng email
 */
authRoutes.post('/signin', asyncHandler(async (req: Request, res: Response) => {
  const { email, password, deviceId, deviceName, platform } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Vui lòng nhập email và mật khẩu!',
    });
  }

  const result = await authService.signIn({
    email,
    password,
    deviceId,
    deviceName,
    platform,
    ipAddress: req.ip,
  });

  // Set cookies
  setAuthCookies(res, result.accessToken, result.refreshToken);

  res.json({
    success: true,
    message: 'Đăng nhập thành công!',
    user: result.user,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    permissions: result.permissions || [],
    roles: result.roles || [],
  });
}));

/**
 * POST /signin-phone - Đăng nhập bằng số điện thoại
 */
authRoutes.post('/signin-phone', asyncHandler(async (req: Request, res: Response) => {
  const { number, password, deviceId, deviceName, platform } = req.body;

  if (!number || !password) {
    return res.status(400).json({
      success: false,
      message: 'Vui lòng nhập số điện thoại và mật khẩu!',
    });
  }

  const result = await authService.signInWithPhone({
    number,
    password,
    deviceId,
    deviceName,
    platform,
    ipAddress: req.ip,
  });

  // Set cookies
  setAuthCookies(res, result.accessToken, result.refreshToken);

  res.json({
    success: true,
    message: 'Đăng nhập thành công!',
    user: result.user,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    permissions: result.permissions || [],
    roles: result.roles || [],
  });
}));

/**
 * POST /signout - Đăng xuất
 */
authRoutes.post('/signout', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { deviceId } = req.body;

  if (userId) {
    await authService.signOut(userId, deviceId);
  }

  // Clear cookies
  clearAuthCookies(res);

  res.json({
    success: true,
    message: 'Đăng xuất thành công!',
  });
}));

/**
 * POST /refresh-token - Làm mới token
 */
authRoutes.post('/refresh-token', asyncHandler(async (req: Request, res: Response) => {
  // Get refresh token from cookie or body
  let refreshToken = req.cookies?.[authConfig.cookie.refreshTokenName] || req.body.refreshToken;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      message: 'Refresh token không được để trống!',
    });
  }

  const tokens = await authService.refreshToken(refreshToken);

  // Set new cookies
  setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

  res.json({
    success: true,
    message: 'Làm mới token thành công!',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
}));

/**
 * PUT /change-password - Đổi mật khẩu
 */
authRoutes.put('/change-password', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { currentPassword, newPassword } = req.body;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Chưa đăng nhập!',
    });
  }

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới!',
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Mật khẩu mới phải có ít nhất 6 ký tự!',
    });
  }

  await authService.changePassword(userId, currentPassword, newPassword);

  // Clear cookies (force re-login)
  clearAuthCookies(res);

  res.json({
    success: true,
    message: 'Đổi mật khẩu thành công! Vui lòng đăng nhập lại.',
  });
}));

/**
 * GET /check - Kiểm tra trạng thái đăng nhập
 */
authRoutes.get('/check', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({
      authenticated: false,
      message: 'Chưa đăng nhập!',
    });
  }

  const user = await authService.checkAuth(userId);

  res.json({
    authenticated: true,
    user,
  });
}));

/**
 * GET /me - Lấy thông tin user hiện tại
 */
authRoutes.get('/me', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Chưa đăng nhập!',
    });
  }

  const user = await authService.getUserById(userId);

  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Không tìm thấy tài khoản!',
    });
  }

  res.json({
    success: true,
    user,
  });
}));
