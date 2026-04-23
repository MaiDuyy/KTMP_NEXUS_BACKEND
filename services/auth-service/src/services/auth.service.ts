// services/auth-service/src/services/auth.service.ts
// Migrate từ src/controllers/auth.controller.ts

import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { authConfig } from '../config/auth.config.js';
import { rbacClient, UserPermissions } from '../lib/rbac-client.js';



type AccountRole = 'EMPLOYEE' | 'SUPER_ADMIN' | 'WORKSPACE_MANAGER';

// ============= TOKEN HELPERS =============

// Enhanced token payload with RBAC info
// Uses standard JWT 'sub' claim (matches @ott/shared JwtPayload & API Gateway)
interface TokenPayload {
  sub: string;
  role: AccountRole;
  roles?: string[];
  roleLevel?: number;
}

const generateToken = (userId: string, role: AccountRole, rbacRoles?: string[], roleLevel?: number): string => {
  const payload: TokenPayload = { sub: userId, role };
  if (rbacRoles?.length) {
    payload.roles = rbacRoles;
    payload.roleLevel = roleLevel;
  }
  return jwt.sign(
    payload,
    authConfig.secret as string,
    { expiresIn: authConfig.accessTokenExpiry as SignOptions["expiresIn"] }
  );
};

// Refresh token claims (separate from access token)
interface RefreshTokenClaims {
  sub: string;
  role: AccountRole;
  jti: string;     // JWT ID — unique identifier for this token
  fid: string;     // Family ID — shared across rotated tokens
}

/**
 * Generate a DB-backed refresh token with JTI for single-use enforcement.
 * Uses a SEPARATE secret from access tokens to prevent cross-use.
 * @param familyId - Reuse existing family on rotation, or create new on login
 */
const generateRefreshToken = async (
  userId: string,
  role: AccountRole,
  familyId?: string
): Promise<{ token: string; jti: string }> => {
  const jti = uuidv4();
  const fId = familyId || uuidv4();

  const token = jwt.sign(
    { sub: userId, role, jti, fid: fId } as RefreshTokenClaims,
    authConfig.refreshSecret as string,
    { expiresIn: authConfig.refreshTokenExpiry as SignOptions["expiresIn"] }
  );

  // Store in DB for revocation tracking
  await prisma.refreshToken.create({
    data: {
      jti,
      userId,
      familyId: fId,
      expiresAt: new Date(Date.now() + authConfig.refreshTokenTtlMs),
    },
  });

  return { token, jti };
};
// ============= OTP HELPERS =============

type OtpType = 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'CHANGE_EMAIL';

const generateOtpCode = (length: number = 6): string => {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  return otp;
};

// ============= AUTH SERVICE =============

export class AuthService {
  /**
   * Đăng ký tài khoản mới
   */
  async signUp(input: {
    name: string;
    email: string;
    number: string;
    password: string;
    gender: string;
    birthDate?: string;
    location?: string;
    role?: AccountRole;
  }) {
    const { name, email, number, password, gender, birthDate, location, role } = input;

    // Check existing
    const existingEmail = await prisma.account.findUnique({ where: { email } });
    if (existingEmail) {
      throw new Error('Email đã được sử dụng!');
    }

    const existingNumber = await prisma.account.findUnique({ where: { number } });
    if (existingNumber) {
      throw new Error('Số điện thoại đã được sử dụng!');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create account
    const newAccount = await prisma.account.create({
      data: {
        id: uuidv4(),
        name,
        email,
        number,
        password: hashedPassword,
        gender,
        birthDate: birthDate ? new Date(birthDate) : null,
        location: location || null,
        role: role || 'EMPLOYEE',
        isVerified: false,
        isOnline: false,
      },
    });

    // Assign EMPLOYEE role via RBAC service (non-blocking)
    rbacClient.assignRole(newAccount.id, 'EMPLOYEE', newAccount.id).then(success => {
      if (success) {
        logger.info({ userId: newAccount.id }, 'EMPLOYEE role assigned via RBAC');
      } else {
        logger.warn({ userId: newAccount.id }, 'Failed to assign EMPLOYEE role via RBAC');
      }
    }).catch(err => {
      logger.warn({ error: err, userId: newAccount.id }, 'RBAC service unavailable during signup');
    });

    // Publish event with full user data for userorg-service sync
    await publishEvent(EventSubjects.USER_CREATED, {
      id: newAccount.id,
      email: newAccount.email,
      name: newAccount.name,
      number: newAccount.number,
      gender: newAccount.gender,
      birthDate: newAccount.birthDate?.toISOString() || null,
      location: newAccount.location,
      role: newAccount.role,
      createdAt: newAccount.createdAt.toISOString(),
    });

    // Generate and send OTP for email verification
    const otpCode = generateOtpCode(6);
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await prisma.otp.create({
      data: {
        email: newAccount.email,
        code: otpCode,
        type: 'VERIFY_EMAIL',
        expiresAt: otpExpiry,
      },
    });

    // Publish OTP send event
    await publishEvent(EventSubjects.OTP_SEND, {
      email: newAccount.email,
      otpCode,
      type: 'VERIFY_EMAIL' as OtpType,
    });

    // Log audit
    await this.logAudit(newAccount.id, 'REGISTER', 'account', { email });

    logger.info({ userId: newAccount.id }, 'User registered, OTP sent');

    return {
      id: newAccount.id,
      name: newAccount.name,
      email: newAccount.email,
      number: newAccount.number,
      role: newAccount.role,
    };
  }

  /**
   * Đăng nhập bằng email
   */
  async signIn(input: {
    email: string;
    password: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    ipAddress?: string;
  }) {
    const { email, password, deviceId, deviceName, platform, ipAddress } = input;

    // Find user
    const user = await prisma.account.findUnique({ where: { email } });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new Error('Mật khẩu không đúng!');
    }

    // USER-08: Check if account is suspended
    if ((user as { isSuspended?: boolean }).isSuspended) {
      throw new Error('Tài khoản đã bị đình chỉ. Vui lòng liên hệ quản trị viên.');
    }

    // Check verified
    if (!user.isVerified) {
      throw new Error('Tài khoản chưa được xác thực!');
    }

    // Get RBAC permissions (non-blocking fallback)
    let rbacRoles: string[] = [];
    let roleLevel: number | undefined;
    let userPermissions: string[] = [];
    try {
      const permissions = await rbacClient.getUserPermissions(user.id);
      if (permissions) {
        rbacRoles = permissions.roles;
        roleLevel = permissions.roleLevel;
        userPermissions = permissions.permissions.map(
          (p) => `${p.resource}.${p.action}`
        );
      }
    } catch {
      logger.warn({ userId: user.id }, 'RBAC service unavailable, using legacy role');
    }

    // Generate tokens with RBAC roles
    const accessToken = generateToken(user.id, user.role as AccountRole, rbacRoles, roleLevel);
    const { token: refreshToken } = await generateRefreshToken(user.id, user.role as AccountRole);

    // Update online status
    await prisma.account.update({
      where: { id: user.id },
      data: { isOnline: true, lastSeen: new Date() },
    });

    // Save device info
    if (deviceId && deviceName && platform) {
      await prisma.loggedInDevice.deleteMany({
        where: { userId: user.id, deviceId },
      });

      await prisma.loggedInDevice.create({
        data: {
          id: uuidv4(),
          userId: user.id,
          deviceId,
          deviceName,
          platform,
          accessToken,
          ipAddress: ipAddress || null,
          lastActive: new Date(),
        },
      });
    }

    // Publish event
    await publishEvent(EventSubjects.USER_ONLINE, {
      userId: user.id,
      timestamp: new Date().toISOString(),
    });

    // Log audit
    await this.logAudit(user.id, 'LOGIN', 'session', { deviceId, platform });

    logger.info({ userId: user.id }, 'User logged in');

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        number: user.number,
        avatar: user.avatar,
        role: user.role,
        isVerified: user.isVerified,
      },
      accessToken,
      refreshToken,
      permissions: userPermissions,
      roles: rbacRoles,
    };
  }

  /**
   * Đăng nhập bằng số điện thoại
   */
  async signInWithPhone(input: {
    number: string;
    password: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    ipAddress?: string;
  }) {
    const { number, password, ...rest } = input;

    // Find user by phone
    const user = await prisma.account.findUnique({ where: { number } });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    // Use signIn logic with email
    return this.signIn({ email: user.email, password, ...rest });
  }

  /**
   * Đăng xuất
   */
  async signOut(userId: string, deviceId?: string) {
    // Update offline status
    await prisma.account.update({
      where: { id: userId },
      data: { isOnline: false, lastSeen: new Date() },
    });

    // Revoke ALL refresh tokens for this user
    await prisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
    });

    // Remove device
    if (deviceId) {
      await prisma.loggedInDevice.deleteMany({
        where: { userId, deviceId },
      });
    }

    // Publish event
    await publishEvent(EventSubjects.USER_OFFLINE, {
      userId,
      lastSeen: new Date().toISOString(),
    });

    // Log audit
    await this.logAudit(userId, 'LOGOUT', 'session', { deviceId });

    logger.info({ userId }, 'User logged out, all refresh tokens revoked');
  }

  /**
   * Refresh token
   */
  async refreshToken(oldRefreshToken: string) {
    // 1. Verify with SEPARATE refresh secret
    let decoded: RefreshTokenClaims;
    try {
      decoded = jwt.verify(oldRefreshToken, authConfig.refreshSecret) as RefreshTokenClaims;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Refresh token đã hết hạn!');
      }
      throw new Error('Refresh token không hợp lệ!');
    }

    // 2. Find stored token by JTI
    const storedToken = await prisma.refreshToken.findUnique({
      where: { jti: decoded.jti },
    });

    if (!storedToken) {
      throw new Error('Refresh token không tồn tại!');
    }

    // 3. THEFT DETECTION: If token was already revoked, someone is replaying it
    //    Revoke the ENTIRE family to protect the user
    if (storedToken.isRevoked) {
      await prisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId },
        data: { isRevoked: true },
      });
      logger.warn(
        { userId: storedToken.userId, familyId: storedToken.familyId, jti: decoded.jti },
        'SECURITY: Refresh token reuse detected — entire family revoked'
      );
      throw new Error('Phiên đăng nhập không an toàn. Vui lòng đăng nhập lại!');
    }

    // 4. Revoke the current token (single-use)
    await prisma.refreshToken.update({
      where: { jti: decoded.jti },
      data: { isRevoked: true },
    });

    // 5. Check user exists and is not suspended
    const user = await prisma.account.findUnique({
      where: { id: decoded.sub },
    });

    if (!user) {
      throw new Error('Người dùng không tồn tại!');
    }

    if ((user as { isSuspended?: boolean }).isSuspended) {

      // Revoke entire family
      await prisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId },
        data: { isRevoked: true },
      });
      throw new Error('Tài khoản đã bị đình chỉ!');
    }

    // 6. Get fresh RBAC data (permissions may have changed since last login)
    let rbacRoles: string[] = [];
    let roleLevel: number | undefined;
    try {
      const permissions = await rbacClient.getUserPermissions(user.id);
      if (permissions) {
        rbacRoles = permissions.roles;
        roleLevel = permissions.roleLevel;
      }
    } catch {
      logger.warn({ userId: user.id }, 'RBAC unavailable during refresh, using legacy role');
    }

    // 7. Issue new token pair (same family for theft tracking)
    const newAccessToken = generateToken(
      user.id,
      user.role as AccountRole,
      rbacRoles,
      roleLevel
    );
    const { token: newRefreshToken } = await generateRefreshToken(
      user.id,
      user.role as AccountRole,
      storedToken.familyId // same family
    );

    logger.info({ userId: user.id, familyId: storedToken.familyId }, 'Token refreshed');

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  /**
   * Đổi mật khẩu
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.account.findUnique({ where: { id: userId } });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new Error('Mật khẩu hiện tại không đúng!');
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await prisma.account.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    // Revoke ALL refresh tokens (force re-login on all devices)
    await prisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
    });

    // Remove all devices (force re-login)
    await prisma.loggedInDevice.deleteMany({
      where: { userId },
    });

    // Log audit
    await this.logAudit(userId, 'CHANGE_PASSWORD', 'account', {});

    logger.info({ userId }, 'Password changed, all refresh tokens revoked');
  }

  /**
   * Kiểm tra auth
   */
  async checkAuth(userId: string) {
    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        number: true,
        avatar: true,
        role: true,
        isVerified: true,
      },
    });

    if (!user) {
      throw new Error('Người dùng không tồn tại!');
    }

    return user;
  }

  /**
   * Lấy user theo ID
   */
  async getUserById(userId: string) {
    return prisma.account.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        number: true,
        avatar: true,
        role: true,
        isOnline: true,
        lastSeen: true,
        isVerified: true,
        createdAt: true,
      },
    });
  }

  /**
   * Verify OTP
   */
  async verifyOtp(email: string, code: string, type: 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'CHANGE_EMAIL') {
    const otp = await prisma.otp.findFirst({
      where: {
        email,
        code,
        type,
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otp) {
      throw new Error('Mã OTP không hợp lệ hoặc đã hết hạn!');
    }

    // Mark as used
    await prisma.otp.update({
      where: { id: otp.id },
      data: { isUsed: true },
    });

    // If verifying email, update account
    if (type === 'VERIFY_EMAIL') {
      await prisma.account.update({
        where: { email },
        data: { isVerified: true },
      });
    }

    return true;
  }

  /**
   * Log audit event
   */
  private async logAudit(
    userId: string,
    action: string,
    resource: string,
    data: Record<string, any>,
    ipAddress?: string
  ) {
    try {
      await prisma.auditLog.create({
        data: {
          userId,
          action,
          resource,
          data,
          ipAddress,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to log audit');
    }
  }

  /**
   * Gửi lại OTP verification
   */
  async resendVerificationOtp(email: string): Promise<{
    success: boolean;
    message?: string;
    resendAvailableIn?: number;
  }> {
    // Check if account exists
    const account = await prisma.account.findUnique({ where: { email } });
    if (!account) {
      throw new Error('Tài khoản không tồn tại!');
    }

    if (account.isVerified) {
      throw new Error('Tài khoản đã được xác thực!');
    }

    // Check cooldown (60 seconds)
    const recentOtp = await prisma.otp.findFirst({
      where: {
        email,
        type: 'VERIFY_EMAIL',
        createdAt: {
          gte: new Date(Date.now() - 60 * 1000), // Within last 60 seconds
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentOtp) {
      const waitTime = Math.ceil((recentOtp.createdAt.getTime() + 60000 - Date.now()) / 1000);
      return {
        success: false,
        message: `Vui lòng đợi ${waitTime} giây trước khi gửi lại OTP.`,
        resendAvailableIn: waitTime,
      };
    }

    // Invalidate old OTPs
    await prisma.otp.updateMany({
      where: {
        email,
        type: 'VERIFY_EMAIL',
        isUsed: false,
      },
      data: { isUsed: true },
    });

    // Generate new OTP
    const otpCode = generateOtpCode(6);
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await prisma.otp.create({
      data: {
        email,
        code: otpCode,
        type: 'VERIFY_EMAIL',
        expiresAt: otpExpiry,
      },
    });

    // Publish OTP send event
    await publishEvent(EventSubjects.OTP_SEND, {
      email,
      otpCode,
      type: 'VERIFY_EMAIL' as OtpType,
    });

    logger.info({ email }, 'OTP resent');

    return { success: true };
  }
}

export const authService = new AuthService();
