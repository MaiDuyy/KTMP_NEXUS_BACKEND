import { describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import { mockPrisma, mockPublishEvent } from '../mocks.js';

// Import after mocks are set up
let channelService: typeof import('../../services/channel.service.js').channelService;

beforeAll(async () => {
  ({ channelService } = await import('../../services/channel.service.js'));
});

describe('ChannelService', () => {
  beforeEach(() => {
    mockPrisma.channel.findUnique.mockReset();
    mockPrisma.channel.findMany.mockReset();
    mockPrisma.channel.create.mockReset();
    mockPrisma.channel.update.mockReset();
    mockPrisma.channel.delete.mockReset();
    mockPrisma.channel.count.mockReset();
    mockPrisma.channelMember.findUnique.mockReset();
    mockPrisma.channelMember.create.mockReset();
    mockPrisma.channelMember.delete.mockReset();
    mockPrisma.workspaceMember.findUnique.mockReset();
    mockPrisma.channelCategory.findFirst.mockReset();
    mockPublishEvent.mockReset();
  });

  describe('createChannel', () => {
    it('should create public channel with creator as owner', async () => {
      // Arrange
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        role: 'MEMBER',
      });
      mockPrisma.channel.findUnique.mockResolvedValue(null); // no name conflict
      mockPrisma.channel.create.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        name: 'general',
        type: 'PUBLIC',
        creatorId: 'user-1',
        createdAt: new Date(),
        members: [{ userId: 'user-1', role: 'OWNER' }],
        category: null,
      });

      // Act
      const result = await channelService.createChannel(
        'ws-1',
        { name: 'general', type: 'PUBLIC' },
        'user-1'
      );

      // Assert
      expect(result.id).toBe('ch-1');
      expect(result.name).toBe('general');
      expect(mockPrisma.channel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-1',
            name: 'general',
            type: 'PUBLIC',
            creatorId: 'user-1',
            members: { create: { userId: 'user-1', role: 'OWNER' } },
          }),
        })
      );
      expect(mockPublishEvent).toHaveBeenCalled();
    });

    it('should throw error for short channel name', async () => {
      await expect(
        channelService.createChannel('ws-1', { name: 'a' }, 'user-1')
      ).rejects.toThrow('Tên channel phải có ít nhất 2 ký tự!');
    });

    it('should not allow non-admin to create private channel', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        role: 'MEMBER', // Not ADMIN/OWNER
      });

      await expect(
        channelService.createChannel('ws-1', { name: 'secret', type: 'PRIVATE' }, 'user-1')
      ).rejects.toThrow('Chỉ Admin/Owner mới có thể tạo channel Private/Guest!');
    });

    it('should throw error for duplicate channel name', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channel.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        channelService.createChannel('ws-1', { name: 'general' }, 'user-1')
      ).rejects.toThrow('Tên channel đã tồn tại trong workspace này!');
    });
  });

  describe('getChannel', () => {
    it('should return channel details for member', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        name: 'general',
        type: 'PUBLIC',
        members: [{ id: 'm-1', userId: 'user-1', role: 'MEMBER' }],
        category: null,
        _count: { members: 1 },
      });

      const result = await channelService.getChannel('ch-1', 'user-1');

      expect(result.id).toBe('ch-1');
      expect(result.members).toHaveLength(1);
    });

    it('should throw error when channel not found', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue(null);

      await expect(channelService.getChannel('non-existent', 'user-1')).rejects.toThrow(
        'Không tìm thấy channel!'
      );
    });

    it('should throw error for non-member on private channel', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        type: 'PRIVATE',
        members: [], // user is not a member
        _count: { members: 5 },
      });

      await expect(channelService.getChannel('ch-1', 'non-member')).rejects.toThrow(
        'Bạn không có quyền xem channel này!'
      );
    });
  });

  describe('archiveChannel', () => {
    it('should archive channel by admin', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'admin-1', role: 'ADMIN' }],
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
      mockPrisma.channel.update.mockResolvedValue({
        id: 'ch-1',
        isArchived: true,
        archivedAt: new Date(),
        archivedBy: 'admin-1',
      });

      const result = await channelService.archiveChannel('ch-1', 'admin-1');

      expect(result.isArchived).toBe(true);
      expect(mockPublishEvent).toHaveBeenCalled();
    });
  });

  describe('joinPublicChannel', () => {
    it('should allow joining public channel', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        type: 'PUBLIC',
        isArchived: false,
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        role: 'MEMBER',
      });
      mockPrisma.channelMember.findUnique.mockResolvedValue(null); // not already member
      mockPrisma.channelMember.create.mockResolvedValue({
        id: 'm-1',
        channelId: 'ch-1',
        userId: 'user-1',
        role: 'MEMBER',
      });

      const result = await channelService.joinPublicChannel('ch-1', 'user-1');

      expect(result.role).toBe('MEMBER');
      expect(mockPrisma.channelMember.create).toHaveBeenCalled();
    });

    it('should not allow joining private channel', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        type: 'PRIVATE',
        isArchived: false,
      });

      await expect(channelService.joinPublicChannel('ch-1', 'user-1')).rejects.toThrow(
        'Chỉ có thể tự join channel Public!'
      );
    });

    it('should not allow joining archived channel', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        type: 'PUBLIC',
        isArchived: true,
      });

      await expect(channelService.joinPublicChannel('ch-1', 'user-1')).rejects.toThrow(
        'Channel đã được archive!'
      );
    });
  });

  describe('browseChannels', () => {
    it('should return paginated public channels', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
      mockPrisma.channel.findMany.mockResolvedValue([
        { id: 'ch-1', name: 'general', members: [], _count: { members: 10 } },
        { id: 'ch-2', name: 'random', members: [{ id: 'm-1' }], _count: { members: 5 } },
      ]);
      mockPrisma.channel.count.mockResolvedValue(2);

      const result = await channelService.browseChannels('ws-1', 'user-1');

      expect(result.items).toHaveLength(2);
      expect(result.items[0].isJoined).toBe(false);
      expect(result.items[1].isJoined).toBe(true);
      expect(result.total).toBe(2);
    });
  });

  describe('addMember', () => {
    it('should add member to channel', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'admin-1', role: 'ADMIN' }],
      });
      mockPrisma.workspaceMember.findUnique
        .mockResolvedValueOnce(null) // adder not workspace admin
        .mockResolvedValueOnce({ userId: 'new-user', role: 'MEMBER' }); // target is workspace member
      mockPrisma.channelMember.create.mockResolvedValue({
        id: 'm-2',
        channelId: 'ch-1',
        userId: 'new-user',
        role: 'MEMBER',
      });

      const result = await channelService.addMember('ch-1', 'new-user', 'admin-1');

      expect(result.role).toBe('MEMBER');
      expect(mockPublishEvent).toHaveBeenCalled();
    });

    it('should throw error when target not workspace member', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'admin-1', role: 'ADMIN' }],
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);

      await expect(channelService.addMember('ch-1', 'external-user', 'admin-1')).rejects.toThrow(
        'Người dùng không phải thành viên của workspace!'
      );
    });
  });

  describe('updateMemberPermission', () => {
    it('should update canPost permission', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'admin-1', role: 'ADMIN' }],
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
      mockPrisma.channelMember.findUnique.mockResolvedValue({
        id: 'm-1',
        userId: 'user-1',
        role: 'MEMBER',
      });
      mockPrisma.channelMember.update.mockResolvedValue({
        id: 'm-1',
        canPost: false,
      });

      const result = await channelService.updateMemberPermission('ch-1', 'user-1', false, 'admin-1');

      expect(result.canPost).toBe(false);
    });
  });
});
