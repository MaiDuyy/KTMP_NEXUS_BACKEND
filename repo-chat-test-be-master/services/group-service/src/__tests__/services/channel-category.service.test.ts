import { describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import { mockPrisma } from '../mocks.js';

// Import after mocks are set up
let channelCategoryService: typeof import('../../services/channel-category.service.js').channelCategoryService;

beforeAll(async () => {
  ({ channelCategoryService } = await import('../../services/channel-category.service.js'));
});

describe('ChannelCategoryService', () => {
  beforeEach(() => {
    mockPrisma.channelCategory.findUnique.mockReset();
    mockPrisma.channelCategory.findFirst.mockReset();
    mockPrisma.channelCategory.findMany.mockReset();
    mockPrisma.channelCategory.create.mockReset();
    mockPrisma.channelCategory.update.mockReset();
    mockPrisma.channelCategory.delete.mockReset();
    mockPrisma.workspaceMember.findUnique.mockReset();
    mockPrisma.channel.findUnique.mockReset();
    mockPrisma.channel.update.mockReset();
    mockPrisma.channel.updateMany.mockReset();
  });

  describe('createCategory', () => {
    it('should create category by admin', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channelCategory.findUnique.mockResolvedValue(null); // no name conflict
      mockPrisma.channelCategory.findFirst.mockResolvedValue({ position: 0 }); // last category
      
      mockPrisma.channelCategory.create.mockResolvedValue({
        id: 'cat-1',
        workspaceId: 'ws-1',
        name: 'Dev Team',
        position: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await channelCategoryService.createCategory(
        'ws-1',
        { name: 'Dev Team' },
        'admin-1'
      );

      expect(result.id).toBe('cat-1');
      expect(result.position).toBe(1);
      expect(mockPrisma.channelCategory.create).toHaveBeenCalled();
    });

    it('should throw error for non-admin', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'MEMBER' });

      await expect(
        channelCategoryService.createCategory('ws-1', { name: 'Test' }, 'member-1')
      ).rejects.toThrow('Bạn không có quyền tạo category!');
    });

    it('should throw error for duplicate name', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      // Use mockImplementationOnce to handle multiple calls if needed, or ensuring precedence
      mockPrisma.channelCategory.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        channelCategoryService.createCategory('ws-1', { name: 'Dev Team' }, 'admin-1')
      ).rejects.toThrow('Tên category đã tồn tại!');
    });
  });

  describe('updateCategory', () => {
    it('should update category name', async () => {
      mockPrisma.channelCategory.findUnique.mockResolvedValue({ workspaceId: 'ws-1' });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channelCategory.update.mockResolvedValue({
        id: 'cat-1',
        name: 'New Name',
      });

      const result = await channelCategoryService.updateCategory(
        'cat-1',
        { name: 'New Name' },
        'admin-1'
      );

      expect(result.name).toBe('New Name');
    });
  });

  describe('deleteCategory', () => {
    it('should delete category and unassign channels', async () => {
      mockPrisma.channelCategory.findUnique.mockResolvedValue({
        id: 'cat-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channel.updateMany.mockResolvedValue({ count: 5 });
      mockPrisma.channelCategory.delete.mockResolvedValue({ id: 'cat-1' });

      const result = await channelCategoryService.deleteCategory('cat-1', 'admin-1');

      expect(result.deleted).toBe(true);
      expect(mockPrisma.channel.updateMany).toHaveBeenCalledWith({
        where: { categoryId: 'cat-1' },
        data: { categoryId: null },
      });
    });
  });

  describe('moveChannelToCategory', () => {
    it('should move channel to category', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channelCategory.findUnique.mockResolvedValue({
        id: 'cat-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.channel.update.mockResolvedValue({
        id: 'ch-1',
        categoryId: 'cat-1',
      });

      const result = await channelCategoryService.moveChannelToCategory(
        'ch-1',
        'cat-1',
        'admin-1'
      );

      expect(result.categoryId).toBe('cat-1');
    });

    it('should throw error if category in different workspace', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channelCategory.findUnique.mockResolvedValue({
        id: 'cat-2',
        workspaceId: 'ws-2', // different workspace
      });

      await expect(
        channelCategoryService.moveChannelToCategory('ch-1', 'cat-2', 'admin-1')
      ).rejects.toThrow('Category không hợp lệ!');
    });
  });
});
