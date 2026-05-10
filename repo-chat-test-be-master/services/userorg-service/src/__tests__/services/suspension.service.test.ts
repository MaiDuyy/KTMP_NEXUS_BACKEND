import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockPrisma, mockPublishEvent } from '../setup.js';

let suspensionService: typeof import('../../services/suspension.service.js').suspensionService;

beforeAll(async () => {
  ({ suspensionService } = await import('../../services/suspension.service.js'));
});

describe('SuspensionService', () => {
  beforeEach(() => {
    mockPrisma.account.findUnique.mockReset();
    mockPrisma.account.findMany.mockReset();
    mockPrisma.account.update.mockReset();
    mockPrisma.account.count.mockReset();
    mockPublishEvent.mockReset();
  });

  describe('suspendUser', () => {
    it('should suspend user with reason', async () => {
      const mockUser = {
        id: 'user-1',
        name: 'Test User',
        email: 'test@test.com',
        isSuspended: false,
      };

      mockPrisma.account.findUnique.mockResolvedValue(mockUser);
      mockPrisma.account.update.mockResolvedValue({
        ...mockUser,
        isSuspended: true,
        suspendedAt: new Date(),
      });

      const result = await suspensionService.suspendUser('user-1', {
        reason: 'Violation of terms',
        suspendedBy: 'admin-1',
      });

      expect(result.isSuspended).toBe(true);
      expect(result.suspendReason).toBe('Violation of terms');
      expect(mockPublishEvent).toHaveBeenCalled();
    });

    it('should throw for short reason', async () => {
      await expect(
        suspensionService.suspendUser('user-1', {
          reason: 'bad',
          suspendedBy: 'admin-1',
        })
      ).rejects.toThrow('Lý do đình chỉ phải có ít nhất 5 ký tự!');
    });

    it('should throw for non-existent user', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await expect(
        suspensionService.suspendUser('non-existent', {
          reason: 'Valid reason here',
          suspendedBy: 'admin-1',
        })
      ).rejects.toThrow('Không tìm thấy tài khoản!');
    });

    it('should throw for already suspended user', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'user-1',
        isSuspended: true,
      });

      await expect(
        suspensionService.suspendUser('user-1', {
          reason: 'Valid reason here',
          suspendedBy: 'admin-1',
        })
      ).rejects.toThrow('Tài khoản đã bị đình chỉ trước đó!');
    });

    it('should throw for self-suspension', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'admin-1',
        isSuspended: false,
      });

      await expect(
        suspensionService.suspendUser('admin-1', {
          reason: 'Trying to suspend myself',
          suspendedBy: 'admin-1',
        })
      ).rejects.toThrow('Không thể đình chỉ tài khoản của chính mình!');
    });
  });

  describe('unsuspendUser', () => {
    it('should unsuspend user', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'user-1',
        isSuspended: true,
        suspendedAt: new Date(),
        suspendedBy: 'admin-1',
        suspendReason: 'Previous reason',
      });
      mockPrisma.account.update.mockResolvedValue({
        id: 'user-1',
        isSuspended: false,
      });

      const result = await suspensionService.unsuspendUser('user-1', 'admin-2');

      expect(result.isSuspended).toBe(false);
      expect(mockPublishEvent).toHaveBeenCalled();
    });

    it('should throw for non-suspended user', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'user-1',
        isSuspended: false,
      });

      await expect(
        suspensionService.unsuspendUser('user-1', 'admin-1')
      ).rejects.toThrow('Tài khoản không bị đình chỉ!');
    });
  });

  describe('isSuspended', () => {
    it('should return true for suspended user', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({ isSuspended: true });

      const result = await suspensionService.isSuspended('user-1');

      expect(result).toBe(true);
    });

    it('should return false for non-suspended user', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({ isSuspended: false });

      const result = await suspensionService.isSuspended('user-1');

      expect(result).toBe(false);
    });

    it('should return false for non-existent user', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      const result = await suspensionService.isSuspended('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('listSuspendedUsers', () => {
    it('should return paginated suspended users', async () => {
      const mockUsers = [
        {
          id: 'user-1',
          name: 'User 1',
          email: 'user1@test.com',
          suspendedAt: new Date(),
          suspendedBy: 'admin-1',
          suspendReason: 'Reason 1',
        },
      ];
      mockPrisma.account.findMany.mockResolvedValue(mockUsers);
      mockPrisma.account.count.mockResolvedValue(1);

      const result = await suspensionService.listSuspendedUsers({
        page: 1,
        limit: 10,
      });

      expect(result.users.length).toBe(1);
      expect(result.total).toBe(1);
      expect(mockPrisma.account.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isSuspended: true },
          skip: 0,
          take: 10,
        })
      );
    });
  });
});
