import { describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import { mockPrisma, mockPublishEvent } from '../mocks.js';

// Import after mocks are set up
let workspaceService: typeof import('../../services/workspace.service.js').workspaceService;

beforeAll(async () => {
  ({ workspaceService } = await import('../../services/workspace.service.js'));
});

describe('WorkspaceService', () => {
  beforeEach(() => {
    mockPrisma.workspace.findUnique.mockReset();
    mockPrisma.workspace.findFirst.mockReset();
    mockPrisma.workspace.findMany.mockReset();
    mockPrisma.workspace.create.mockReset();
    mockPrisma.workspace.update.mockReset();
    mockPrisma.workspace.delete.mockReset();
    mockPrisma.workspaceMember.findUnique.mockReset();
    mockPrisma.workspaceMember.create.mockReset();
    mockPrisma.workspaceMember.delete.mockReset();
    mockPrisma.channel.findMany.mockReset();
    mockPrisma.channelMember.createMany.mockReset();
    mockPublishEvent.mockReset();
  });

  describe('createWorkspace', () => {
    it('should create workspace with owner as first member', async () => {
      // Arrange
      const userId = 'user-1';
      const input = { name: 'My Workspace', description: 'Test workspace' };
      
      mockPrisma.workspace.findUnique.mockResolvedValue(null); // no slug conflict
      mockPrisma.workspace.create.mockResolvedValue({
        id: 'ws-1',
        name: 'My Workspace',
        description: 'Test workspace',
        slug: 'my-workspace',
        ownerId: userId ,
        isPublic: false,
        allowGuestAccess: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        members: [{ userId, role: 'OWNER' }],
      });

      // Act
      const result = await workspaceService.createWorkspace(input, userId);

      // Assert
      expect(result.id).toBe('ws-1');
      expect(result.name).toBe('My Workspace');
      expect(mockPrisma.workspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'My Workspace',
            ownerId: userId,
            members: { create: { userId, role: 'OWNER' } },
          }),
        })
      );
      expect(mockPublishEvent).toHaveBeenCalled();
    });

    it('should throw error for short name', async () => {
      await expect(
        workspaceService.createWorkspace({ name: 'A' }, 'user-1')
      ).rejects.toThrow('Tên workspace phải có ít nhất 2 ký tự!');
    });

    it('should throw error for duplicate slug', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        workspaceService.createWorkspace({ name: 'Existing Workspace' }, 'user-1')
      ).rejects.toThrow('Slug đã tồn tại!');
    });
  });

  describe('getWorkspace', () => {
    it('should return workspace with members and channels', async () => {
      const mockWorkspace = {
        id: 'ws-1',
        name: 'Test Workspace',
        slug: 'test-workspace',
        isPublic: false,
        members: [{ id: 'm-1', userId: 'user-1', role: 'OWNER' }],
        channels: [{ id: 'ch-1', name: 'general', type: 'PUBLIC' }],
        categories: [],
        _count: { members: 1, channels: 1 },
      };

      mockPrisma.workspace.findFirst.mockResolvedValue(mockWorkspace);

      const result = await workspaceService.getWorkspace('ws-1', 'user-1');

      expect(result.id).toBe('ws-1');
      expect(result.members).toHaveLength(1);
      expect(result.channels).toHaveLength(1);
    });

    it('should throw error when workspace not found', async () => {
      mockPrisma.workspace.findFirst.mockResolvedValue(null);

      await expect(
        workspaceService.getWorkspace('non-existent', 'user-1')
      ).rejects.toThrow('Không tìm thấy workspace!');
    });

    it('should throw error for non-member on private workspace', async () => {
      mockPrisma.workspace.findFirst.mockResolvedValue({
        id: 'ws-1',
        isPublic: false,
        members: [], // user is not a member
        channels: [],
        categories: [],
        _count: { members: 1, channels: 0 },
      });

      await expect(
        workspaceService.getWorkspace('ws-1', 'non-member')
      ).rejects.toThrow('Bạn không có quyền xem workspace này!');
    });
  });

  describe('addMember', () => {
    const mockWorkspace = (members: any[]) => ({
      id: 'ws-1',
      name: 'Test',
      ownerId: 'owner-1',
      members,
    });

    it('should add member with MEMBER role', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue(
        mockWorkspace([{ userId: 'admin-1', role: 'ADMIN' }])
      );
      mockPrisma.workspaceMember.create.mockResolvedValue({
        id: 'm-2',
        workspaceId: 'ws-1',
        userId: 'new-user',
        role: 'MEMBER',
      });
      mockPrisma.channel.findMany.mockResolvedValue([]); // no default channels
      mockPrisma.channelMember.createMany.mockResolvedValue({ count: 0 });

      const result = await workspaceService.addMember('ws-1', 'new-user', 'MEMBER', 'admin-1');

      expect(result.role).toBe('MEMBER');
      expect(mockPrisma.workspaceMember.create).toHaveBeenCalled();
      expect(mockPublishEvent).toHaveBeenCalled();
    });

    it('should throw error for non-admin inviter', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue(
        mockWorkspace([{ userId: 'member-1', role: 'MEMBER' }])
      );

      await expect(
        workspaceService.addMember('ws-1', 'new-user', 'MEMBER', 'member-1')
      ).rejects.toThrow('Bạn không có quyền thêm thành viên!');
    });

    it('should throw error when user already member', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue(
        mockWorkspace([
          { userId: 'admin-1', role: 'ADMIN' },
          { userId: 'existing-user', role: 'MEMBER' },
        ])
      );

      await expect(
        workspaceService.addMember('ws-1', 'existing-user', 'MEMBER', 'admin-1')
      ).rejects.toThrow('Người dùng đã là thành viên!');
    });

    it('should auto-join default channels', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue(
        mockWorkspace([{ userId: 'admin-1', role: 'ADMIN' }])
      );
      mockPrisma.workspaceMember.create.mockResolvedValue({
        id: 'm-2',
        userId: 'new-user',
        role: 'MEMBER',
      });
      mockPrisma.channel.findMany.mockResolvedValue([
        { id: 'ch-1', isDefault: true },
        { id: 'ch-2', isDefault: true },
      ]);
      mockPrisma.channelMember.createMany.mockResolvedValue({ count: 2 });

      await workspaceService.addMember('ws-1', 'new-user', 'MEMBER', 'admin-1');

      expect(mockPrisma.channelMember.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ channelId: 'ch-1', userId: 'new-user' }),
          expect.objectContaining({ channelId: 'ch-2', userId: 'new-user' }),
        ]),
        skipDuplicates: true,
      });
    });
  });

  describe('removeMember', () => {
    it('should allow self-leave for non-owner', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [
          { id: 'm-1', userId: 'owner-1', role: 'OWNER' },
          { id: 'm-2', userId: 'member-1', role: 'MEMBER' },
        ],
      });
      mockPrisma.workspaceMember.delete.mockResolvedValue({});
      mockPrisma.channelMember.deleteMany.mockResolvedValue({ count: 0 });

      const result = await workspaceService.removeMember('ws-1', 'member-1', 'member-1');

      expect(result.removed).toBe(true);
      expect(mockPrisma.workspaceMember.delete).toHaveBeenCalled();
    });

    it('should not allow owner to leave', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [{ id: 'm-1', userId: 'owner-1', role: 'OWNER' }],
      });

      await expect(
        workspaceService.removeMember('ws-1', 'owner-1', 'owner-1')
      ).rejects.toThrow('Owner không thể rời workspace!');
    });
  });

  describe('deleteWorkspace', () => {
    it('should delete workspace by owner', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [{ userId: 'owner-1', role: 'OWNER' }],
      });
      mockPrisma.workspace.delete.mockResolvedValue({});

      const result = await workspaceService.deleteWorkspace('ws-1', 'owner-1');

      expect(result.deleted).toBe(true);
      expect(mockPublishEvent).toHaveBeenCalled();
    });

    it('should not allow non-owner to delete', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [
          { userId: 'owner-1', role: 'OWNER' },
          { userId: 'admin-1', role: 'ADMIN' },
        ],
      });

      await expect(
        workspaceService.deleteWorkspace('ws-1', 'admin-1')
      ).rejects.toThrow('Chỉ Owner mới có thể xóa workspace!');
    });
  });
});
