// services/identity-service/src/services/auth.service.ts
// KEY REFACTOR: rbacClient HTTP calls → direct rbacPrisma queries

import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { authPrisma, userorgPrisma, rbacPrisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { authConfig } from '../config/auth.config.js';
import { auditLogService } from './audit.service.js';
import { getQuotaByRole } from '../lib/quota.js';

type AccountRole = 'SUPER_ADMIN' | 'ADMIN' | 'WORKSPACE_MANAGER' | 'EMPLOYEE';

interface TokenPayload {
  sub: string;
  name: string;
  role: AccountRole;
  orgId?: string;
  roles?: string[];
  roleLevel?: number;
}

const generateToken = (userId: string, name: string, role: AccountRole, orgId?: string, rbacRoles?: string[], roleLevel?: number): string => {
  const payload: TokenPayload = { sub: userId, name, role, orgId };
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

interface RefreshTokenClaims {
  sub: string;
  role: AccountRole;
  jti: string;
  fid: string;
}

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

  await authPrisma.refreshToken.create({
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

// ============= RBAC DIRECT QUERIES (replaces HTTP rbacClient) =============

async function getRbacPermissions(userId: string) {
  try {
    const userRoles = await rbacPrisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: {
            permissions: {
              include: { permission: true }
            }
          }
        }
      },
    });

    if (userRoles.length === 0) return null;

    const roles = userRoles.map(ur => ur.role.name);
    const roleLevel = Math.min(...userRoles.map(ur => ur.role.level), 999);

    const permissionSet = new Map<string, { resource: string; action: string; scope: string }>();
    for (const userRole of userRoles) {
      for (const rp of userRole.role.permissions) {
        const key = `${rp.permission.resource}:${rp.permission.action}:${rp.permission.scope}`;
        if (!permissionSet.has(key)) {
          permissionSet.set(key, {
            resource: rp.permission.resource,
            action: rp.permission.action,
            scope: rp.permission.scope,
          });
        }
      }
    }

    return {
      userId,
      roles,
      roleLevel,
      permissions: Array.from(permissionSet.values()),
    };
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to get RBAC permissions via Prisma');
    return null;
  }
}

async function assignRbacRole(userId: string, roleName: string, grantedBy: string): Promise<boolean> {
  try {
    const role = await rbacPrisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      logger.warn({ roleName }, 'RBAC role not found');
      return false;
    }

    await rbacPrisma.userRole.create({
      data: {
        userId,
        roleId: role.id,
        grantedBy,
      },
    });

    return true;
  } catch (error) {
    logger.warn({ error, userId, roleName }, 'Failed to assign RBAC role');
    return false;
  }
}

// ============= AUTH SERVICE =============

export class AuthService {
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

    const existingEmail = await authPrisma.account.findUnique({ where: { email } });
    if (existingEmail) {
      throw new Error('Email đã được sử dụng!');
    }

    const existingNumber = await authPrisma.account.findUnique({ where: { number } });
    if (existingNumber) {
      throw new Error('Số điện thoại đã được sử dụng!');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newAccount = await authPrisma.account.create({
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
        maxWorkspaces: getQuotaByRole(role || 'EMPLOYEE'),
      },
    });

    // ⚡ SYNC: Create record in userorg schema as well
    // Both are part of the unified identity-service
    await userorgPrisma.account.create({
      data: {
        id: newAccount.id,
        name: newAccount.name,
        email: newAccount.email,
        number: newAccount.number,
        password: newAccount.password, // userorg also has password field for redundancy or local profile management
        gender: newAccount.gender,
        birthDate: newAccount.birthDate,
        location: newAccount.location,
        role: newAccount.role as any,
        isVerified: false,
        maxWorkspaces: getQuotaByRole(newAccount.role || 'EMPLOYEE'),
      }
    }).catch(err => {
      logger.error({ err, userId: newAccount.id }, 'Failed to sync user to userorg schema');
      // We don't throw here to avoid failing registration if only the secondary schema fails, 
      // but in a unified service this should ideally be in a transaction.
    });

    // ⚡ REFACTORED: Direct Prisma query instead of HTTP call
    assignRbacRole(newAccount.id, 'EMPLOYEE', newAccount.id).then(success => {
      if (success) {
        logger.info({ userId: newAccount.id }, 'EMPLOYEE role assigned via direct RBAC query');
      } else {
        logger.warn({ userId: newAccount.id }, 'Failed to assign EMPLOYEE role');
      }
    });

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

    const otpCode = generateOtpCode(6);
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);

    await authPrisma.otp.create({
      data: {
        email: newAccount.email,
        code: otpCode,
        type: 'VERIFY_EMAIL',
        expiresAt: otpExpiry,
      },
    });

    await publishEvent(EventSubjects.OTP_SEND, {
      email: newAccount.email,
      otpCode,
      type: 'VERIFY_EMAIL' as OtpType,
    });

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

  async createAccountFromInvitation(data: {
    email: string;
    name: string;
    password: string;
    gender?: string;
    role?: string;
    workspaceId?: string;
    orgId?: string;
    channelIds?: string[];
    type?: string;
    invitedBy?: string;
  }) {
    const { email, name, password, gender, role, workspaceId, orgId, channelIds, type, invitedBy } = data;

    // 1. Check if email exists
    const existing = await authPrisma.account.findUnique({ where: { email } });
    if (existing) {
      logger.warn({ email }, 'Attempted to create account from invitation but email already exists');
      return existing;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const accountRole = (role || 'EMPLOYEE') as AccountRole;

    // 2. Create in Auth Schema
    const authAccount = await authPrisma.account.create({
      data: {
        id: userId,
        name,
        email,
        number: `INV_${userId.slice(0, 8)}`, // Placeholder number
        password: hashedPassword,
        gender: gender || 'other',
        role: accountRole,
        isVerified: true,
        maxWorkspaces: getQuotaByRole(accountRole),
      },
    });

    // 3. Create in UserOrg Schema
    await userorgPrisma.account.create({
      data: {
        id: userId,
        name,
        email,
        number: authAccount.number,
        password: hashedPassword,
        gender: authAccount.gender,
        role: accountRole as any,
        orgId: orgId || null,
        isVerified: true,
        maxWorkspaces: getQuotaByRole(accountRole),
      }
    });

    // 4. Assign RBAC Role
    await assignRbacRole(userId, accountRole, 'INVITATION_SYSTEM');

    // 5. Notify messaging-service if needed (Sync via gRPC to avoid race condition)
    if (workspaceId) {
      try {
        const { messagingGrpc } = await import('../lib/messagingClient.js');
        const grpcResult = await messagingGrpc.addMember(
          workspaceId,
          userId,
          accountRole,
          invitedBy
        );
        if (!grpcResult.success) {
          logger.error({ userId, workspaceId, message: grpcResult.message }, 'Failed to add member via gRPC in createAccountFromInvitation');
        }
      } catch (err) {
        logger.error({ err, userId, workspaceId }, 'gRPC error in createAccountFromInvitation');
      }

      await publishEvent('invitation.joined', {
        userId,
        email,
        workspaceId,
        role: accountRole,
        channelIds: channelIds || [],
        orgId,
        type: type || 'USER',
        invitedBy,
        timestamp: new Date().toISOString(),
      });
    }

    await publishEvent(EventSubjects.USER_CREATED, {
      id: userId,
      email,
      name,
      role: accountRole,
      createdAt: new Date().toISOString(),
    });

    logger.info({ userId, email, role: accountRole }, 'Account created from invitation');

    // 6. Generate Tokens for "Auto-Login"
    const rbacRoles = [accountRole];
    const roleLevel = 4; // Default level for members/guests
    const userPermissions: string[] = []; // Initial empty permissions

    const accessToken = generateToken(userId, name, accountRole, orgId || undefined, rbacRoles, roleLevel);
    const { token: refreshToken } = await generateRefreshToken(userId, accountRole);

    return {
      user: {
        id: userId,
        name,
        email,
        role: accountRole,
        orgId: orgId || null,
        isVerified: true,
      },
      accessToken,
      refreshToken,
      roles: rbacRoles,
      permissions: userPermissions,
    };
  }

  async registerOrganization(input: {
    name: string;
    email: string;
    number: string;
    password: string;
    gender: string;
    organizationName: string;
    workspaceName?: string;
  }) {
    const { name, email, number, password, gender, organizationName, workspaceName } = input;

    // 1. Check if email exists
    const existingEmail = await authPrisma.account.findUnique({ where: { email } });
    if (existingEmail) {
      throw new Error('Email đã được sử dụng!');
    }

    // 2. Check domain
    const domain = email.split('@')[1].toLowerCase();
    const existingOrg = await userorgPrisma.organization.findFirst({ where: { domain } });
    if (existingOrg) {
      throw new Error(`Domain ${domain} đã thuộc tổ chức khác. Vui lòng liên hệ quản trị viên.`);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    // 3. Create Organization
    const orgSlug = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const organization = await userorgPrisma.organization.create({
      data: {
        name: organizationName,
        slug: orgSlug,
        domain,
        superAdminId: userId,
      },
    });

    // 4. Create Account in both schemas
    const newAccount = await authPrisma.account.create({
      data: {
        id: userId,
        name,
        email,
        number,
        password: hashedPassword,
        gender,
        role: 'WORKSPACE_MANAGER',
        isVerified: true, // Auto-verify for organization creator? Or send OTP?
        maxWorkspaces: getQuotaByRole('WORKSPACE_MANAGER'),
      },
    });

    await userorgPrisma.account.create({
      data: {
        id: userId,
        name,
        email,
        number,
        password: hashedPassword,
        gender,
        role: 'WORKSPACE_MANAGER',
        orgId: organization.id,
        isVerified: true,
        maxWorkspaces: getQuotaByRole('WORKSPACE_MANAGER'),
      },
    });

    // 5. Assign SUPER_ADMIN role in RBAC
    await assignRbacRole(userId, 'SUPER_ADMIN', userId);

    // 6. Request messaging-service to create Workspace via gRPC
    // In a real microservice, we'd use NATS or gRPC. 
    // Since WorkspaceService uses messagingGrpc, we'll try that if it has the method.
    // For now, we'll publish an event for messaging-service to handle.
    const wsName = workspaceName || organizationName;
    const wsSlug = wsName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    await publishEvent(EventSubjects.ORGANIZATION_CREATED, {
      orgId: organization.id,
      orgName: organization.name,
      ownerId: userId,
      adminId: userId, // Added to match subscriber expectation
      workspaceName: wsName,
      workspaceSlug: wsSlug,
    });

    await this.logAudit(userId, 'REGISTER_ORG', 'organization', { organizationName, domain });

    logger.info({ userId, orgId: organization.id }, 'Organization registered successfully');

    return {
      user: {
        id: userId,
        name,
        email,
        role: 'WORKSPACE_MANAGER',
      },
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
    };
  }

  async createOrganization(userId: string, input: {
    organizationName: string;
    workspaceName?: string;
  }) {
    const { organizationName, workspaceName } = input;

    // 1. Get user to check email/domain
    const user = await authPrisma.account.findUnique({ where: { id: userId } });
    if (!user) throw new Error('Không tìm thấy người dùng!');

    const domain = user.email.split('@')[1].toLowerCase();
    const existingOrg = await userorgPrisma.organization.findFirst({ where: { domain } });
    if (existingOrg) {
      throw new Error(`Domain ${domain} đã thuộc tổ chức khác.`);
    }

    // 2. Create Organization
    const orgSlug = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const organization = await userorgPrisma.organization.create({
      data: {
        name: organizationName,
        slug: orgSlug,
        domain,
        superAdminId: userId,
      },
    });

    // 3. Update Account role to WORKSPACE_MANAGER if not already
    await authPrisma.account.update({
      where: { id: userId },
      data: { 
        role: 'WORKSPACE_MANAGER',
        maxWorkspaces: getQuotaByRole('WORKSPACE_MANAGER')
      },
    });

    await userorgPrisma.account.update({
      where: { id: userId },
      data: { 
        role: 'WORKSPACE_MANAGER', 
        orgId: organization.id,
        maxWorkspaces: getQuotaByRole('WORKSPACE_MANAGER')
      },
    });

    // 4. Assign RBAC Role
    await assignRbacRole(userId, 'SUPER_ADMIN', userId);

    // 5. Publish Event for messaging-service
    const wsName = workspaceName || organizationName;
    const wsSlug = wsName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).substring(2, 5);

    await publishEvent(EventSubjects.ORGANIZATION_CREATED, {
      orgId: organization.id,
      orgName: organization.name,
      ownerId: userId,
      adminId: userId,
      workspaceName: wsName,
      workspaceSlug: wsSlug,
    });

    await this.logAudit(userId, 'CREATE_ORG', 'organization', { organizationName, domain });

    return {
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
    };
  }


  async signIn(input: {
    email: string;
    password: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    ipAddress?: string;
  }) {
    const { email, password, deviceId, deviceName, platform, ipAddress } = input;

    const user = await authPrisma.account.findUnique({ where: { email } });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new Error('Mật khẩu không đúng!');
    }

    // 🛡️ SECURITY: Double check suspension in userorg schema (source of truth for admin actions)
    const suspensionCheck = await userorgPrisma.account.findUnique({
      where: { id: user.id },
      select: { isSuspended: true }
    });

    if (suspensionCheck?.isSuspended) {
      throw new Error('Tài khoản đã bị đình chỉ. Vui lòng liên hệ quản trị viên.');
    }

    if (!user.isVerified) {
      throw new Error('Tài khoản chưa được xác thực!');
    }

    // Fetch orgId from userorg schema
    const orgAccount = await userorgPrisma.account.findUnique({
      where: { id: user.id },
      select: { orgId: true }
    });
    const orgId = orgAccount?.orgId || undefined;

    // ⚡ REFACTORED: Direct Prisma query instead of HTTP call to rbac-service
    let rbacRoles: string[] = [];
    let roleLevel: number | undefined;
    let userPermissions: string[] = [];
    try {
      const permissions = await getRbacPermissions(user.id);
      if (permissions) {
        rbacRoles = permissions.roles;
        roleLevel = permissions.roleLevel;
        userPermissions = permissions.permissions.map(
          (p) => `${p.resource}.${p.action}`
        );
      }
    } catch {
      logger.warn({ userId: user.id }, 'RBAC query failed, using legacy role');
    }

    const accessToken = generateToken(user.id, user.name, user.role as AccountRole, orgId, rbacRoles, roleLevel);
    const { token: refreshToken } = await generateRefreshToken(user.id, user.role as AccountRole);

    await authPrisma.account.update({
      where: { id: user.id },
      data: { isOnline: true, lastSeen: new Date() },
    });

    // ⚡ SYNC: Update online status in userorg schema
    await userorgPrisma.account.update({
      where: { id: user.id },
      data: { isOnline: true, lastSeen: new Date() },
    }).catch(() => {});

    if (deviceId && deviceName && platform) {
      await authPrisma.loggedInDevice.deleteMany({
        where: { userId: user.id, deviceId },
      });

      await authPrisma.loggedInDevice.create({
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

    await publishEvent(EventSubjects.USER_ONLINE, {
      userId: user.id,
      timestamp: new Date().toISOString(),
    });

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
        orgId: orgId,
        isVerified: user.isVerified,
      },
      accessToken,
      refreshToken,
      permissions: userPermissions,
      roles: rbacRoles,
    };
  }

  async signInWithPhone(input: {
    number: string;
    password: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    ipAddress?: string;
  }) {
    const { number, password, ...rest } = input;
    const user = await authPrisma.account.findUnique({ where: { number } });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    return this.signIn({ email: user.email, password, ...rest });
  }

  async signOut(userId: string, deviceId?: string) {
    await authPrisma.account.update({
      where: { id: userId },
      data: { isOnline: false, lastSeen: new Date() },
    });

    // ⚡ SYNC: Update offline status in userorg schema
    await userorgPrisma.account.update({
      where: { id: userId },
      data: { isOnline: false, lastSeen: new Date() },
    }).catch(() => {});

    await authPrisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
    });

    if (deviceId) {
      await authPrisma.loggedInDevice.deleteMany({
        where: { userId, deviceId },
      });
    }

    await publishEvent(EventSubjects.USER_OFFLINE, {
      userId,
      lastSeen: new Date().toISOString(),
    });

    await this.logAudit(userId, 'LOGOUT', 'session', { deviceId });

    logger.info({ userId }, 'User logged out, all refresh tokens revoked');
  }

  async refreshToken(oldRefreshToken: string) {
    let decoded: RefreshTokenClaims;
    try {
      decoded = jwt.verify(oldRefreshToken, authConfig.refreshSecret) as RefreshTokenClaims;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Refresh token đã hết hạn!');
      }
      throw new Error('Refresh token không hợp lệ!');
    }

    const storedToken = await authPrisma.refreshToken.findUnique({
      where: { jti: decoded.jti },
    });

    if (!storedToken) {
      throw new Error('Refresh token không tồn tại!');
    }

    if (storedToken.isRevoked) {
      await authPrisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId },
        data: { isRevoked: true },
      });
      logger.warn(
        { userId: storedToken.userId, familyId: storedToken.familyId, jti: decoded.jti },
        'SECURITY: Refresh token reuse detected — entire family revoked'
      );
      throw new Error('Phiên đăng nhập không an toàn. Vui lòng đăng nhập lại!');
    }

    await authPrisma.refreshToken.update({
      where: { jti: decoded.jti },
      data: { isRevoked: true },
    });

    const user = await authPrisma.account.findUnique({
      where: { id: decoded.sub },
    });

    if (!user) {
      throw new Error('Người dùng không tồn tại!');
    }

    // 🛡️ SECURITY: Double check suspension in userorg schema
    const suspensionCheck = await userorgPrisma.account.findUnique({
      where: { id: user.id },
      select: { isSuspended: true }
    });

    if (suspensionCheck?.isSuspended) {
      await authPrisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId },
        data: { isRevoked: true },
      });
      throw new Error('Tài khoản đã bị đình chỉ!');
    }

    // ⚡ REFACTORED: Direct Prisma query instead of HTTP call
    let rbacRoles: string[] = [];
    let roleLevel: number | undefined;
    try {
      const permissions = await getRbacPermissions(user.id);
      if (permissions) {
        rbacRoles = permissions.roles;
        roleLevel = permissions.roleLevel;
      }
    } catch {
      logger.warn({ userId: user.id }, 'RBAC unavailable during refresh, using legacy role');
    }

    // Fetch orgId from userorg schema
    const orgAccount = await userorgPrisma.account.findUnique({
      where: { id: user.id },
      select: { orgId: true }
    });
    const orgId = orgAccount?.orgId || undefined;

    const newAccessToken = generateToken(
      user.id,
      user.name,
      user.role as AccountRole,
      orgId,
      rbacRoles,
      roleLevel
    );
    const { token: newRefreshToken } = await generateRefreshToken(
      user.id,
      user.role as AccountRole,
      storedToken.familyId
    );

    logger.info({ userId: user.id, familyId: storedToken.familyId }, 'Token refreshed');

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await authPrisma.account.findUnique({ where: { id: userId } });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new Error('Mật khẩu hiện tại không đúng!');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await authPrisma.account.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await authPrisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
    });

    await authPrisma.loggedInDevice.deleteMany({
      where: { userId },
    });

    await this.logAudit(userId, 'CHANGE_PASSWORD', 'account', {});

    logger.info({ userId }, 'Password changed, all refresh tokens revoked');
  }

  async checkAuth(userId: string) {
    const user = await authPrisma.account.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        number: true,
        avatar: true,
        role: true,
        isVerified: true,
        isSuspended: true, // Added for enforcement
      },
    });

    if (!user) {
      throw new Error('Người dùng không tồn tại!');
    }

    // 🛡️ SECURITY: Double check suspension in userorg schema
    const suspensionCheck = await authPrisma.account.findUnique({
      where: { id: user.id },
      select: { isSuspended: true }
    });

    if (suspensionCheck?.isSuspended) {
      throw new Error('Tài khoản đã bị đình chỉ. Vui lòng liên hệ quản trị viên.');
    }

    return user;
  }

  async getUserById(userId: string) {
    return authPrisma.account.findUnique({
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

  async verifyOtp(email: string, code: string, type: 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'CHANGE_EMAIL') {
    const otp = await authPrisma.otp.findFirst({
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

    await authPrisma.otp.update({
      where: { id: otp.id },
      data: { isUsed: true },
    });

    if (type === 'VERIFY_EMAIL') {
      await authPrisma.account.update({
        where: { email },
        data: { isVerified: true },
      });

      // ⚡ SYNC: Update verified status in userorg schema
      await userorgPrisma.account.update({
        where: { email },
        data: { isVerified: true },
      }).catch(() => {});
    }

    return true;
  }

  private async logAudit(
    userId: string,
    action: string,
    resource: string,
    data: Record<string, any>,
    ipAddress?: string
  ) {
    await auditLogService.createLog({
      userId,
      action,
      resource,
      data,
      ipAddress,
    }).catch(error => {
      logger.error({ error }, 'Failed to log audit via service');
    });
  }

  async resendVerificationOtp(email: string): Promise<{
    success: boolean;
    message?: string;
    resendAvailableIn?: number;
  }> {
    const account = await authPrisma.account.findUnique({ where: { email } });
    if (!account) {
      throw new Error('Tài khoản không tồn tại!');
    }

    if (account.isVerified) {
      throw new Error('Tài khoản đã được xác thực!');
    }

    const recentOtp = await authPrisma.otp.findFirst({
      where: {
        email,
        type: 'VERIFY_EMAIL',
        createdAt: {
          gte: new Date(Date.now() - 60 * 1000),
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

    await authPrisma.otp.updateMany({
      where: {
        email,
        type: 'VERIFY_EMAIL',
        isUsed: false,
      },
      data: { isUsed: true },
    });

    const otpCode = generateOtpCode(6);
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);

    await authPrisma.otp.create({
      data: {
        email,
        code: otpCode,
        type: 'VERIFY_EMAIL',
        expiresAt: otpExpiry,
      },
    });

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
