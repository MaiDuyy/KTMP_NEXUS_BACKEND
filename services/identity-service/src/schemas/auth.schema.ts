// services/identity-service/src/schemas/auth.schema.ts

import { z } from 'zod';

export const signUpSchema = z.object({
  name: z.string().min(2, 'Tên phải có ít nhất 2 ký tự').max(255, 'Tên không được quá 255 ký tự'),
  email: z.string().email('Email không hợp lệ').toLowerCase(),
  number: z.string().regex(/^[0-9]{10,11}$/, 'Số điện thoại phải có 10-11 chữ số'),
  password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự').max(100, 'Mật khẩu không được quá 100 ký tự'),
  gender: z.enum(['male', 'female', 'other'], { errorMap: () => ({ message: 'Giới tính không hợp lệ' }) }),
  birthDate: z.string().optional(),
  location: z.string().max(255).optional(),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MANAGER', 'EMPLOYEE']).optional(),
});

export const signInSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(1, 'Mật khẩu không được để trống'),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  platform: z.string().optional(),
});

export const signInPhoneSchema = z.object({
  number: z.string().regex(/^[0-9]{10,11}$/, 'Số điện thoại không hợp lệ'),
  password: z.string().min(1, 'Mật khẩu không được để trống'),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  platform: z.string().optional(),
});

export const verifyOtpSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  code: z.string().length(6, 'Mã OTP phải có 6 chữ số'),
});

export const resendOtpSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Mật khẩu hiện tại không được để trống'),
  newPassword: z.string().min(6, 'Mật khẩu mới phải có ít nhất 6 ký tự').max(100, 'Mật khẩu không được quá 100 ký tự'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().optional(),
});

export const registerOrgSchema = z.object({
  name: z.string().min(2, 'Tên phải có ít nhất 2 ký tự').max(255),
  email: z.string().email('Email không hợp lệ').toLowerCase(),
  number: z.string().regex(/^[0-9]{10,11}$/, 'Số điện thoại phải có 10-11 chữ số'),
  password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự').max(100),
  gender: z.enum(['male', 'female', 'other']),
  organizationName: z.string().min(2, 'Tên tổ chức phải có ít nhất 2 ký tự').max(200),
  workspaceName: z.string().min(2, 'Tên workspace phải có ít nhất 2 ký tự').max(100).optional(),
});
export const createOrgSchema = z.object({
  organizationName: z.string().min(2, 'Tên tổ chức phải có ít nhất 2 ký tự').max(200),
  workspaceName: z.string().min(2, 'Tên workspace phải có ít nhất 2 ký tự').max(100).optional(),
});
