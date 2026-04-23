import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockPrisma, mockPublishEvent } from '../setup.js';

// Import after mocks are set up
let userService: typeof import('../../services/user.service.js').userService;

beforeAll(async () => {
  ({ userService } = await import('../../services/user.service.js'));
});

describe('UserService', () => {
  beforeEach(() => {
    mockPrisma.account.findUnique.mockReset();
    mockPrisma.account.update.mockReset();
    mockPrisma.account.findMany.mockReset();
    mockPrisma.account.count.mockReset();
    mockPublishEvent.mockReset();
  });

  describe('getProfile', () => {
    it('should return user profile when found', async () => {
      const mockUser = {
        id: 'user-1',
        name: 'Test User',
        email: 'test@test.com',
        avatar: null,
        status: 'Hello!',
        birthDate: null,
        location: 'VN',
        gender: 'MALE',
        isOnline: true,
        lastSeen: new Date(),
        role: 'EMPLOYEE',
        createdAt: new Date(),
      };

      mockPrisma.account.findUnique.mockResolvedValue(mockUser);

      const result = await userService.getProfile('user-1');

      expect(result).toEqual(mockUser);
      expect(mockPrisma.account.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: expect.any(Object),
      });
    });

    it('should throw error when user not found', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await expect(userService.getProfile('non-existent')).rejects.toThrow('Không tìm thấy tài khoản!');
    });
  });

  describe('updateProfile', () => {
    it('should update user profile and publish event', async () => {
      const updatedUser = {
        id: 'user-1',
        name: 'Updated Name',
        avatar: 'new-avatar.jpg',
      };

      mockPrisma.account.update.mockResolvedValue(updatedUser);

      const result = await userService.updateProfile('user-1', {
        name: 'Updated Name',
        avatar: 'new-avatar.jpg',
      });

      expect(result).toEqual(updatedUser);
      expect(mockPrisma.account.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          name: 'Updated Name',
          avatar: 'new-avatar.jpg',
        }),
        select: expect.any(Object),
      });
      expect(mockPublishEvent).toHaveBeenCalled();
    });
  });

  describe('updateOnlineStatus', () => {
    it('should update online status to true', async () => {
      mockPrisma.account.update.mockResolvedValue({ isOnline: true });

      await userService.updateOnlineStatus('user-1', true);

      expect(mockPrisma.account.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          isOnline: true,
        }),
      });
    });

    it('should update online status to false with lastSeen', async () => {
      mockPrisma.account.update.mockResolvedValue({ isOnline: false });

      await userService.updateOnlineStatus('user-1', false);

      expect(mockPrisma.account.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          isOnline: false,
          lastSeen: expect.any(Date),
        }),
      });
    });
  });

  describe('getAllUsers', () => {
    it('should return paginated users', async () => {
      const mockUsers = [
        { id: 'user-1', name: 'User 1', email: 'user1@test.com' },
        { id: 'user-2', name: 'User 2', email: 'user2@test.com' },
      ];
      mockPrisma.account.findMany.mockResolvedValue(mockUsers);
      mockPrisma.account.count.mockResolvedValue(2);

      const result = await userService.getAllUsers({ page: 1, limit: 10 });

      expect(result.users).toEqual(mockUsers);
      expect(result.pagination.total).toBe(2);
      expect(mockPrisma.account.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 10,
        })
      );
    });

    it('should filter by search term', async () => {
      mockPrisma.account.findMany.mockResolvedValue([]);
      mockPrisma.account.count.mockResolvedValue(0);

      await userService.getAllUsers({ search: 'john' });

      expect(mockPrisma.account.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { name: { contains: 'john', mode: 'insensitive' } },
              { email: { contains: 'john', mode: 'insensitive' } },
            ]),
          }),
        })
      );
    });
  });

  describe('getUserById', () => {
    it('should return user by id', async () => {
      const mockUser = { id: 'user-1', name: 'Test', email: 'test@test.com' };
      mockPrisma.account.findUnique.mockResolvedValue(mockUser);

      const result = await userService.getUserById('user-1');

      expect(result).toEqual(mockUser);
    });

    it('should throw error for non-existent user', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await expect(userService.getUserById('non-existent')).rejects.toThrow('Không tìm thấy tài khoản!');
    });
  });
});
