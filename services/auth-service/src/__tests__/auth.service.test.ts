// Auth Service Unit Tests
// Covers roles: EMPLOYEE, SUPER_ADMIN, WORKSPACE_MANAGER (via RBAC)
// AccountRole: USER, ADMIN, MODERATOR (legacy in auth-service)

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { 
  mockPrisma, 
  mockRbacClient, 
  mockPublishEvent,
  createMockUser, 
  createMockEmployee,
  createMockSuperAdmin, 
  createMockWorkspaceManager 
} from './setup';
import { AuthService } from '../services/auth.service';

const authService = new AuthService();
const TEST_SECRET = 'test-secret-key-for-jwt-testing-12345';

describe('AuthService', () => {
  // ============= signUp Tests =============
  describe('signUp', () => {
    const baseInput = {
      name: 'Test User',
      email: 'test@example.com',
      number: '0123456789',
      password: 'password123',
      gender: 'male',
    };

    describe('Role: EMPLOYEE (default USER)', () => {
      it('should create account with USER role (maps to EMPLOYEE in RBAC)', async () => {
        mockPrisma.account.findUnique.mockResolvedValue(null);
        mockPrisma.account.create.mockResolvedValue(createMockEmployee());
        mockPrisma.otp.create.mockResolvedValue({ id: 'otp-1' });
        mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

        const result = await authService.signUp(baseInput);

        expect(result).toBeDefined();
        expect(result.email).toBe('employee@company.com');
        expect(mockPrisma.account.create).toHaveBeenCalled();
        expect(mockRbacClient.assignRole).toHaveBeenCalledWith(
          expect.any(String),
          'EMPLOYEE',
          expect.any(String)
        );
      });
    });

    describe('Role: SUPER_ADMIN', () => {
      it('should create account with ADMIN role (maps to SUPER_ADMIN in RBAC)', async () => {
        const adminUser = createMockSuperAdmin();
        mockPrisma.account.findUnique.mockResolvedValue(null);
        mockPrisma.account.create.mockResolvedValue(adminUser);
        mockPrisma.otp.create.mockResolvedValue({ id: 'otp-1' });
        mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

        const result = await authService.signUp({
          ...baseInput,
          email: 'admin@company.com',
          role: 'ADMIN',
        });

        expect(result.role).toBe('ADMIN');
        expect(mockPrisma.otp.create).toHaveBeenCalled();
        expect(mockPublishEvent).toHaveBeenCalled();
      });
    });

    describe('Role: WORKSPACE_MANAGER', () => {
      it('should create account with MODERATOR role (maps to WORKSPACE_MANAGER in RBAC)', async () => {
        const managerUser = createMockWorkspaceManager();
        mockPrisma.account.findUnique.mockResolvedValue(null);
        mockPrisma.account.create.mockResolvedValue(managerUser);
        mockPrisma.otp.create.mockResolvedValue({ id: 'otp-1' });
        mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

        const result = await authService.signUp({
          ...baseInput,
          email: 'manager@company.com',
          role: 'MODERATOR',
        });

        expect(result.role).toBe('MODERATOR');
      });
    });

    describe('Error cases', () => {
      it('should throw error when email already exists', async () => {
        mockPrisma.account.findUnique.mockResolvedValueOnce(createMockUser());

        await expect(authService.signUp(baseInput)).rejects.toThrow('Email đã được sử dụng!');
      });

      it('should throw error when phone number already exists', async () => {
        mockPrisma.account.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(createMockUser());

        await expect(authService.signUp(baseInput)).rejects.toThrow('Số điện thoại đã được sử dụng!');
      });
    });
  });

  // ============= signIn Tests =============
  describe('signIn', () => {
    const baseInput = {
      email: 'test@example.com',
      password: 'password',
    };

    describe('Role: EMPLOYEE', () => {
      it('should login EMPLOYEE user and return tokens', async () => {
        const hashedPwd = await bcrypt.hash('password', 10);
        const user = createMockEmployee({ password: hashedPwd });
        mockPrisma.account.findUnique.mockResolvedValue(user);
        mockPrisma.account.update.mockResolvedValue({ ...user, isOnline: true });
        mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });
        mockRbacClient.getUserPermissions.mockResolvedValue({
          roles: ['EMPLOYEE'],
          roleLevel: 10,
        });

        const result = await authService.signIn({ ...baseInput, email: 'employee@company.com' });

        expect(result.user).toBeDefined();
        expect(result.accessToken).toBeDefined();
        expect(result.refreshToken).toBeDefined();
        expect(mockRbacClient.getUserPermissions).toHaveBeenCalledWith(user.id);
      });

      it('should save device info when provided', async () => {
        const hashedPwd = await bcrypt.hash('password', 10);
        const user = createMockEmployee({ password: hashedPwd });
        mockPrisma.account.findUnique.mockResolvedValue(user);
        mockPrisma.account.update.mockResolvedValue({ ...user, isOnline: true });
        mockPrisma.loggedInDevice.deleteMany.mockResolvedValue({ count: 0 });
        mockPrisma.loggedInDevice.create.mockResolvedValue({ id: 'device-1' });
        mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

        await authService.signIn({
          ...baseInput,
          email: 'employee@company.com',
          deviceId: 'device-123',
          deviceName: 'iPhone 15',
          platform: 'iOS',
        });

        expect(mockPrisma.loggedInDevice.create).toHaveBeenCalled();
      });
    });

    describe('Role: SUPER_ADMIN', () => {
      it('should login SUPER_ADMIN with elevated RBAC permissions', async () => {
        const hashedPwd = await bcrypt.hash('password', 10);
        const admin = createMockSuperAdmin({ password: hashedPwd });
        mockPrisma.account.findUnique.mockResolvedValue(admin);
        mockPrisma.account.update.mockResolvedValue({ ...admin, isOnline: true });
        mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });
        mockRbacClient.getUserPermissions.mockResolvedValue({
          roles: ['SUPER_ADMIN', 'ORG_ADMIN'],
          roleLevel: 0,
        });

        const result = await authService.signIn({ ...baseInput, email: 'admin@company.com' });

        expect(result.user.role).toBe('ADMIN');
        expect(mockRbacClient.getUserPermissions).toHaveBeenCalledWith(admin.id);
      });
    });

    describe('Role: WORKSPACE_MANAGER', () => {
      it('should login WORKSPACE_MANAGER successfully', async () => {
        const hashedPwd = await bcrypt.hash('password', 10);
        const manager = createMockWorkspaceManager({ password: hashedPwd });
        mockPrisma.account.findUnique.mockResolvedValue(manager);
        mockPrisma.account.update.mockResolvedValue({ ...manager, isOnline: true });
        mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });
        mockRbacClient.getUserPermissions.mockResolvedValue({
          roles: ['WORKSPACE_MANAGER'],
          roleLevel: 3,
        });

        const result = await authService.signIn({ ...baseInput, email: 'manager@company.com' });

        expect(result.user.role).toBe('MODERATOR');
      });
    });

    describe('Error cases', () => {
      it('should throw error when account not found', async () => {
        mockPrisma.account.findUnique.mockResolvedValue(null);

        await expect(authService.signIn(baseInput)).rejects.toThrow('Không tìm thấy tài khoản!');
      });

      it('should throw error when password is wrong', async () => {
        const hashedPwd = await bcrypt.hash('correctpassword', 10);
        const user = createMockUser({ password: hashedPwd });
        mockPrisma.account.findUnique.mockResolvedValue(user);

        await expect(authService.signIn({ ...baseInput, password: 'wrongpassword' })).rejects.toThrow('Mật khẩu không đúng!');
      });

      it('should throw error when account not verified', async () => {
        const hashedPwd = await bcrypt.hash('password', 10);
        const user = createMockUser({ password: hashedPwd, isVerified: false });
        mockPrisma.account.findUnique.mockResolvedValue(user);

        await expect(authService.signIn(baseInput)).rejects.toThrow('Tài khoản chưa được xác thực!');
      });
    });
  });

  // ============= signInWithPhone Tests =============
  describe('signInWithPhone', () => {
    it('should login with phone number', async () => {
      const hashedPwd = await bcrypt.hash('password', 10);
      const user = createMockUser({ password: hashedPwd });
      mockPrisma.account.findUnique.mockResolvedValue(user);
      mockPrisma.account.update.mockResolvedValue({ ...user, isOnline: true });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      const result = await authService.signInWithPhone({
        number: '0123456789',
        password: 'password',
      });

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBeDefined();
    });

    it('should throw error when phone not found', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await expect(
        authService.signInWithPhone({ number: '0000000000', password: 'password' })
      ).rejects.toThrow('Không tìm thấy tài khoản!');
    });
  });

  // ============= signOut Tests =============
  describe('signOut', () => {
    it('should logout and update offline status', async () => {
      mockPrisma.account.update.mockResolvedValue({ id: 'user-123', isOnline: false });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await authService.signOut('user-123');

      expect(mockPrisma.account.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: expect.objectContaining({ isOnline: false }),
      });
    });

    it('should remove device when deviceId provided', async () => {
      mockPrisma.account.update.mockResolvedValue({ id: 'user-123', isOnline: false });
      mockPrisma.loggedInDevice.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await authService.signOut('user-123', 'device-123');

      expect(mockPrisma.loggedInDevice.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-123', deviceId: 'device-123' },
      });
    });
  });

  // ============= refreshToken Tests =============
  describe('refreshToken', () => {
    it('should return new tokens for valid refresh token', async () => {
      const user = createMockUser();
      const validToken = jwt.sign({ id: user.id, role: 'USER' }, TEST_SECRET, { expiresIn: '7d' });
      mockPrisma.account.findUnique.mockResolvedValue(user);

      const result = await authService.refreshToken(validToken);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('should throw error for expired token', async () => {
      const expiredToken = jwt.sign({ id: 'user-123', role: 'USER' }, TEST_SECRET, { expiresIn: '-1h' });

      await expect(authService.refreshToken(expiredToken)).rejects.toThrow('Refresh token đã hết hạn!');
    });

    it('should throw error for invalid token', async () => {
      await expect(authService.refreshToken('invalid-token-string')).rejects.toThrow('Refresh token không hợp lệ!');
    });
  });

  // ============= changePassword Tests =============
  describe('changePassword', () => {
    it('should change password successfully', async () => {
      const hashedPwd = await bcrypt.hash('currentPassword', 10);
      const user = createMockUser({ password: hashedPwd });
      mockPrisma.account.findUnique.mockResolvedValue(user);
      mockPrisma.account.update.mockResolvedValue(user);
      mockPrisma.loggedInDevice.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await expect(
        authService.changePassword('user-123', 'currentPassword', 'newPassword123')
      ).resolves.not.toThrow();

      expect(mockPrisma.account.update).toHaveBeenCalled();
      expect(mockPrisma.loggedInDevice.deleteMany).toHaveBeenCalled();
    });

    it('should throw error when current password is wrong', async () => {
      const hashedPwd = await bcrypt.hash('correctPassword', 10);
      const user = createMockUser({ password: hashedPwd });
      mockPrisma.account.findUnique.mockResolvedValue(user);

      await expect(
        authService.changePassword('user-123', 'wrongPassword', 'newPassword')
      ).rejects.toThrow('Mật khẩu hiện tại không đúng!');
    });

    it('should throw error when user not found', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await expect(
        authService.changePassword('unknown', 'password', 'newPassword')
      ).rejects.toThrow('Không tìm thấy tài khoản!');
    });
  });

  // ============= checkAuth Tests =============
  describe('checkAuth', () => {
    it('should return user info for valid user', async () => {
      const user = createMockUser();
      mockPrisma.account.findUnique.mockResolvedValue({
        id: user.id,
        name: user.name,
        email: user.email,
        number: user.number,
        avatar: user.avatar,
        role: user.role,
        isVerified: user.isVerified,
      });

      const result = await authService.checkAuth('user-123');

      expect(result).toBeDefined();
      expect(result.email).toBe('test@example.com');
    });

    it('should throw error when user not found', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await expect(authService.checkAuth('unknown')).rejects.toThrow('Người dùng không tồn tại!');
    });
  });

  // ============= getUserById Tests =============
  describe('getUserById', () => {
    it('should return user data', async () => {
      const user = createMockUser();
      mockPrisma.account.findUnique.mockResolvedValue(user);

      const result = await authService.getUserById('user-123');

      expect(result).toBeDefined();
      expect(result.id).toBe('user-123');
    });

    it('should return null when user not found', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      const result = await authService.getUserById('unknown');

      expect(result).toBeNull();
    });
  });

  // ============= verifyOtp Tests =============
  describe('verifyOtp', () => {
    const mockOtp = {
      id: 'otp-1',
      email: 'test@example.com',
      code: '123456',
      type: 'VERIFY_EMAIL',
      isUsed: false,
      expiresAt: new Date(Date.now() + 300000),
    };

    describe('VERIFY_EMAIL', () => {
      it('should verify email OTP and update account', async () => {
        mockPrisma.otp.findFirst.mockResolvedValue(mockOtp);
        mockPrisma.otp.update.mockResolvedValue({ ...mockOtp, isUsed: true });
        mockPrisma.account.update.mockResolvedValue(createMockUser({ isVerified: true }));

        const result = await authService.verifyOtp('test@example.com', '123456', 'VERIFY_EMAIL');

        expect(result).toBe(true);
        expect(mockPrisma.account.update).toHaveBeenCalledWith({
          where: { email: 'test@example.com' },
          data: { isVerified: true },
        });
      });
    });

    describe('RESET_PASSWORD', () => {
      it('should verify reset password OTP', async () => {
        const resetOtp = { ...mockOtp, type: 'RESET_PASSWORD' };
        mockPrisma.otp.findFirst.mockResolvedValue(resetOtp);
        mockPrisma.otp.update.mockResolvedValue({ ...resetOtp, isUsed: true });

        const result = await authService.verifyOtp('test@example.com', '123456', 'RESET_PASSWORD');

        expect(result).toBe(true);
      });
    });

    describe('CHANGE_EMAIL', () => {
      it('should verify change email OTP', async () => {
        const changeOtp = { ...mockOtp, type: 'CHANGE_EMAIL' };
        mockPrisma.otp.findFirst.mockResolvedValue(changeOtp);
        mockPrisma.otp.update.mockResolvedValue({ ...changeOtp, isUsed: true });

        const result = await authService.verifyOtp('test@example.com', '123456', 'CHANGE_EMAIL');

        expect(result).toBe(true);
      });
    });

    describe('Error cases', () => {
      it('should throw error for invalid or expired OTP', async () => {
        mockPrisma.otp.findFirst.mockResolvedValue(null);

        await expect(
          authService.verifyOtp('test@example.com', 'wrong', 'VERIFY_EMAIL')
        ).rejects.toThrow('Mã OTP không hợp lệ hoặc đã hết hạn!');
      });
    });
  });

  // ============= resendVerificationOtp Tests =============
  describe('resendVerificationOtp', () => {
    it('should resend OTP successfully', async () => {
      const user = createMockUser({ isVerified: false });
      mockPrisma.account.findUnique.mockResolvedValue(user);
      mockPrisma.otp.findFirst.mockResolvedValue(null);
      mockPrisma.otp.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.otp.create.mockResolvedValue({ id: 'otp-new' });

      const result = await authService.resendVerificationOtp('test@example.com');

      expect(result.success).toBe(true);
      expect(mockPrisma.otp.create).toHaveBeenCalled();
    });

    it('should throw error when account not found', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await expect(
        authService.resendVerificationOtp('unknown@example.com')
      ).rejects.toThrow('Tài khoản không tồn tại!');
    });

    it('should throw error when account already verified', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(createMockUser({ isVerified: true }));

      await expect(
        authService.resendVerificationOtp('test@example.com')
      ).rejects.toThrow('Tài khoản đã được xác thực!');
    });

    it('should return cooldown when OTP sent recently', async () => {
      const user = createMockUser({ isVerified: false });
      mockPrisma.account.findUnique.mockResolvedValue(user);
      mockPrisma.otp.findFirst.mockResolvedValue({
        id: 'otp-recent',
        createdAt: new Date(Date.now() - 30000),
      });

      const result = await authService.resendVerificationOtp('test@example.com');

      expect(result.success).toBe(false);
      expect(result.resendAvailableIn).toBeGreaterThan(0);
    });
  });
});
