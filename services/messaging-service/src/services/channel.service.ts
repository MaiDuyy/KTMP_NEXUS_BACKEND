// services/messaging-service/src/services/channel.service.ts
// Channel management — migrated from group-service (import paths updated)

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import type { ChannelType, ChannelMemberRole } from '@prisma/client';

interface CreateChannelInput {
  name: string; description?: string; topic?: string;
  type?: ChannelType; categoryId?: string; isDefault?: boolean;
}

interface UpdateChannelInput {
  name?: string; description?: string; topic?: string; categoryId?: string; position?: number;
}

interface BrowseOptions { page?: number; limit?: number; search?: string; }

export class ChannelService {
  private async getWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
    const members = await prisma.workspaceMember.findMany({ where: { workspaceId }, select: { userId: true } });
    return members.map((m: any) => m.userId);
  }

  private async getChannelMemberIds(channelId: string): Promise<string[]> {
    const members = await prisma.channelMember.findMany({ where: { channelId }, select: { userId: true } });
    return members.map((m: any) => m.userId);
  }

  async createChannel(workspaceId: string, data: CreateChannelInput, userId: string) {
    const { name, description, topic, type, categoryId, isDefault } = data;
    if (!name || name.trim().length < 2) throw new Error('Tên channel phải có ít nhất 2 ký tự!');

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) throw new Error('Bạn không phải thành viên của workspace này!');

    const channelType = type || 'PUBLIC';

    // Only WORKSPACE_OWNER and WORKSPACE_ADMIN can create any channel
    const isAdminOrOwner = ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(membership.role);
    if (!isAdminOrOwner)
      throw new Error('Chỉ Admin hoặc Owner của workspace mới có thể tạo kênh!');

    // ANNOUNCEMENT channels require WORKSPACE_OWNER
    if (channelType === 'ANNOUNCEMENT' && membership.role !== 'WORKSPACE_OWNER')
      throw new Error('Chỉ Owner mới có thể tạo kênh Thông báo (ANNOUNCEMENT)!');

    const existing = await prisma.channel.findUnique({
      where: { workspaceId_name: { workspaceId, name: name.trim().toLowerCase() } },
    });
    if (existing) throw new Error('Tên channel đã tồn tại trong workspace này!');

    if (categoryId) {
      const category = await prisma.channelCategory.findFirst({ where: { id: categoryId, workspaceId } });
      if (!category) throw new Error('Category không hợp lệ!');
    }

    const channel = await prisma.channel.create({
      data: {
        workspaceId, name: name.trim().toLowerCase(), description: description?.trim(),
        topic: topic?.trim(), type: channelType, categoryId, isDefault: isDefault ?? false, creatorId: userId,
        members: { create: { userId, role: 'CHANNEL_OWNER' } },
      },
      include: { members: true, category: true },
    });

    // Mirror to Chat table for messaging support
    await prisma.chat.create({
      data: {
        id: channel.id,
        isGroup: true,
        name: channel.name,
        workspaceId: channel.workspaceId,
        joinPolicy: channelType === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
        status: 'ACTIVE',
        participants: {
          create: {
            accountId: userId,
            role: 'CHANNEL_OWNER',
          }
        }
      }
    }).catch((e) => logger.error({ err: e.message }, 'Failed to mirror Channel to Chat'));

    const notifyMemberIds = channelType === 'PUBLIC' || channelType === 'ANNOUNCEMENT' 
      ? await this.getWorkspaceMemberIds(workspaceId) 
      : [userId];

    await publishEvent(EventSubjects.CHANNEL_CREATED, {
      id: channel.id, workspaceId, name: channel.name, type: channel.type,
      createdBy: userId, createdAt: channel.createdAt.toISOString(),
      memberIds: notifyMemberIds,
    });
    logger.info({ channelId: channel.id, workspaceId }, 'Channel created');
    return channel;
  }

  async updateChannel(id: string, data: UpdateChannelInput, userId: string) {
    const channel = await prisma.channel.findUnique({ where: { id }, include: { members: true } });
    if (!channel) throw new Error('Không tìm thấy channel!');

    const channelMember = channel.members.find(m => m.userId === userId);
    const workspaceMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
    });
    const canEdit =
      (channelMember && ['CHANNEL_OWNER', 'CHANNEL_MODERATOR'].includes(channelMember.role)) ||
      (workspaceMember && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(workspaceMember.role));
    if (!canEdit) throw new Error('Bạn không có quyền chỉnh sửa channel này!');

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim().toLowerCase();
    if (data.description !== undefined) updateData.description = data.description?.trim();
    if (data.topic !== undefined) updateData.topic = data.topic?.trim();
    if (data.categoryId !== undefined) updateData.categoryId = data.categoryId;
    if (data.position !== undefined) updateData.position = data.position;

    const updated = await prisma.channel.update({ where: { id }, data: updateData });
    
    const notifyMemberIds = await this.getWorkspaceMemberIds(channel.workspaceId);
    
    // Mirror name update to Chat table
    if (updateData.name !== undefined) {
      await prisma.chat.update({
        where: { id },
        data: { name: updateData.name }
      }).catch(() => null);
    }

    await publishEvent(EventSubjects.CHANNEL_UPDATED, { id, workspaceId: channel.workspaceId, ...updateData, memberIds: notifyMemberIds });
    logger.info({ channelId: id }, 'Channel updated');
    return updated;
  }

  async archiveChannel(id: string, userId: string) {
    await this.getChannelWithPermissionCheck(id, userId, ['CHANNEL_OWNER', 'CHANNEL_MODERATOR']);
    const updated = await prisma.channel.update({
      where: { id }, data: { isArchived: true, archivedAt: new Date(), archivedBy: userId },
    });
    // Mirror to Chat table
    await prisma.chat.update({ where: { id }, data: { status: 'ARCHIVED' } }).catch(() => null);
    
    const notifyMemberIds = await this.getChannelMemberIds(id);
    await publishEvent(EventSubjects.CHANNEL_ARCHIVED, { channelId: id, archivedBy: userId, memberIds: notifyMemberIds });
    logger.info({ channelId: id }, 'Channel archived');
    return updated;
  }

  async unarchiveChannel(id: string, userId: string) {
    await this.getChannelWithPermissionCheck(id, userId, ['CHANNEL_OWNER', 'CHANNEL_MODERATOR']);
    const updated = await prisma.channel.update({
      where: { id }, data: { isArchived: false, archivedAt: null, archivedBy: null },
    });
    // Mirror to Chat table
    await prisma.chat.update({ where: { id }, data: { status: 'ACTIVE' } }).catch(() => null);

    logger.info({ channelId: id }, 'Channel unarchived');
    return updated;
  }

  async deleteChannel(id: string, userId: string) {
    const channel = await this.getChannelWithPermissionCheck(id, userId, ['CHANNEL_OWNER']);
    await prisma.channel.delete({ where: { id } });
    // Mirror to Chat table
    await prisma.chat.delete({ where: { id } }).catch(() => null);
    
    const notifyMemberIds = channel.type === 'PUBLIC' || channel.type === 'ANNOUNCEMENT'
      ? await this.getWorkspaceMemberIds(channel.workspaceId)
      : channel.members.map((m: any) => m.userId);

    await publishEvent(EventSubjects.CHANNEL_DELETED, { channelId: id, workspaceId: channel.workspaceId, deletedBy: userId, memberIds: notifyMemberIds });
    logger.info({ channelId: id }, 'Channel deleted');
    return { deleted: true };
  }

  async getChannel(id: string, userId: string) {
    const channel = await prisma.channel.findUnique({
      where: { id },
      include: {
        members: { select: { id: true, userId: true, role: true, canPost: true, joinedAt: true } },
        category: true, _count: { select: { members: true } },
      },
    });
    if (!channel) throw new Error('Không tìm thấy channel!');

    const isMember = channel.members.some(m => m.userId === userId);
    if (!isMember && channel.type !== 'PUBLIC') throw new Error('Bạn không có quyền xem channel này!');
    return channel;
  }

  async listChannels(workspaceId: string, userId: string, includeArchived = false) {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) throw new Error('Bạn không phải thành viên của workspace này!');

    const whereCondition: any = { workspaceId };
    if (!includeArchived) whereCondition.isArchived = false;
    if (membership.role === 'WORKSPACE_GUEST') {
      whereCondition.OR = [{ type: 'GUEST' }, { members: { some: { userId } } }];
    }

    const channels = await prisma.channel.findMany({
      where: whereCondition,
      include: {
        category: true,
        members: { where: { userId }, select: { role: true, canPost: true, isMuted: true, isPinned: true } },
        _count: { select: { members: true } },
      },
      orderBy: [{ category: { position: 'asc' } }, { position: 'asc' }, { name: 'asc' }],
    });

    return channels.map(ch => ({
      ...ch, isMember: ch.members.length > 0, myMembership: ch.members[0] || null, memberCount: ch._count.members,
    }));
  }

  async addMember(channelId: string, targetUserId: string, adderId: string) {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { members: true } });
    if (!channel) throw new Error('Không tìm thấy channel!');

    const adderChannelMember = channel.members.find(m => m.userId === adderId);
    const adderWorkspaceMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId: adderId } },
    });
    const canAdd =
      (adderChannelMember && ['CHANNEL_OWNER', 'CHANNEL_MODERATOR'].includes(adderChannelMember.role)) ||
      (adderWorkspaceMember && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(adderWorkspaceMember.role));
    if (!canAdd && channel.type !== 'PUBLIC') throw new Error('Bạn không có quyền thêm thành viên vào channel này!');

    const targetWorkspaceMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId: targetUserId } },
    });
    if (!targetWorkspaceMember) throw new Error('Người dùng không phải thành viên của workspace!');

    const existing = channel.members.find(m => m.userId === targetUserId);
    if (existing) throw new Error('Người dùng đã là thành viên của channel!');

    const member = await prisma.channelMember.create({ data: { channelId, userId: targetUserId, role: 'CHANNEL_MEMBER' } });
    // Mirror to Chat table
    await prisma.chatParticipant.create({
      data: { chatId: channelId, accountId: targetUserId, role: 'CHANNEL_MEMBER' }
    }).catch(() => null);

    const notifyMemberIds = await this.getChannelMemberIds(channelId);
    await publishEvent(EventSubjects.CHANNEL_MEMBER_ADDED, { channelId, userId: targetUserId, addedBy: adderId, memberIds: notifyMemberIds });
    logger.info({ channelId, userId: targetUserId }, 'Member added to channel');
    return member;
  }

  async removeMember(channelId: string, targetUserId: string, removerId: string) {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { members: true } });
    if (!channel) throw new Error('Không tìm thấy channel!');

    const target = channel.members.find(m => m.userId === targetUserId);
    if (!target) throw new Error('Người dùng không phải thành viên của channel!');

    if (targetUserId === removerId) {
      if (target.role === 'CHANNEL_OWNER') throw new Error('Owner không thể rời channel! Vui lòng chuyển quyền trước.');
    } else {
      const remover = channel.members.find(m => m.userId === removerId);
      const removerWorkspaceMember = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId: removerId } },
      });
      const canRemove =
        (remover && ['CHANNEL_OWNER', 'CHANNEL_MODERATOR'].includes(remover.role)) ||
        (removerWorkspaceMember && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(removerWorkspaceMember.role));
      if (!canRemove) throw new Error('Bạn không có quyền xóa thành viên!');
    }

    await prisma.channelMember.delete({ where: { id: target.id } });
    // Mirror to Chat table
    await prisma.chatParticipant.deleteMany({
      where: { chatId: channelId, accountId: targetUserId }
    }).catch(() => null);

    const notifyMemberIds = await this.getChannelMemberIds(channelId);
    await publishEvent(EventSubjects.CHANNEL_MEMBER_REMOVED, { channelId, userId: targetUserId, removedBy: removerId, memberIds: notifyMemberIds });
    logger.info({ channelId, userId: targetUserId }, 'Member removed from channel');
    return { removed: true };
  }

  async updateMemberPermission(channelId: string, targetUserId: string, canPost: boolean, updaterId: string) {
    await this.getChannelWithPermissionCheck(channelId, updaterId, ['CHANNEL_OWNER', 'CHANNEL_MODERATOR']);
    const target = await prisma.channelMember.findUnique({ where: { channelId_userId: { channelId, userId: targetUserId } } });
    if (!target) throw new Error('Người dùng không phải thành viên của channel!');
    const updated = await prisma.channelMember.update({ where: { id: target.id }, data: { canPost } });
    logger.info({ channelId, userId: targetUserId, canPost }, 'Member permission updated');
    return updated;
  }

  async setDefaultChannel(channelId: string, isDefault: boolean, userId: string) {
    await this.getChannelWithPermissionCheck(channelId, userId, ['CHANNEL_OWNER', 'CHANNEL_MODERATOR']);
    const updated = await prisma.channel.update({ where: { id: channelId }, data: { isDefault } });
    logger.info({ channelId, isDefault }, 'Channel default status updated');
    return updated;
  }

  async browseChannels(workspaceId: string, userId: string, options: BrowseOptions = {}) {
    const { page = 1, limit = 20, search } = options;
    const skip = (page - 1) * limit;

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) throw new Error('Bạn không phải thành viên của workspace này!');

    const whereCondition: any = { workspaceId, type: 'PUBLIC', isArchived: false };
    if (search) {
      whereCondition.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [channels, total] = await Promise.all([
      prisma.channel.findMany({
        where: whereCondition, skip, take: limit,
        include: { members: { where: { userId }, select: { id: true } }, _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      }),
      prisma.channel.count({ where: whereCondition }),
    ]);

    return {
      channels: channels.map(ch => ({ id: ch.id, name: ch.name, description: ch.description, memberCount: ch._count.members, isJoined: ch.members.length > 0 })),
      total, page, limit, totalPages: Math.ceil(total / limit),
    };
  }

  async joinPublicChannel(channelId: string, userId: string) {
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new Error('Không tìm thấy channel!');
    if (channel.type !== 'PUBLIC') throw new Error('Chỉ có thể tự join channel Public!');
    if (channel.isArchived) throw new Error('Channel đã được archive!');

    const workspaceMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
    });
    if (!workspaceMember) throw new Error('Bạn không phải thành viên của workspace này!');

    const existing = await prisma.channelMember.findUnique({ where: { channelId_userId: { channelId, userId } } });
    if (existing) throw new Error('Bạn đã là thành viên của channel này!');

    const member = await prisma.channelMember.create({ data: { channelId, userId, role: 'CHANNEL_MEMBER' } });
    // Mirror to Chat table
    await prisma.chatParticipant.create({
      data: { chatId: channelId, accountId: userId, role: 'CHANNEL_MEMBER' }
    }).catch(() => null);

    const notifyMemberIds = await this.getChannelMemberIds(channelId);
    await publishEvent(EventSubjects.CHANNEL_MEMBER_ADDED, { channelId, userId, addedBy: userId, memberIds: notifyMemberIds });

    logger.info({ channelId, userId }, 'User joined public channel');
    return member;
  }

  async leaveChannel(channelId: string, userId: string) {
    return this.removeMember(channelId, userId, userId);
  }

  async canUserPost(channelId: string, userId: string): Promise<boolean> {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { members: { where: { userId } } } });
    if (!channel || channel.isArchived) return false;
    const member = channel.members[0];
    if (!member || member.role === 'CHANNEL_GUEST' || !member.canPost) return false;
    return true;
  }

  async canUserRead(channelId: string, userId: string): Promise<boolean> {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { members: { where: { userId } } } });
    if (!channel) return false;
    if (channel.type === 'PUBLIC') {
      const workspaceMember = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
      });
      return !!workspaceMember;
    }
    return channel.members.length > 0;
  }

  async updateMemberPreferences(channelId: string, userId: string, preferences: { isMuted?: boolean; isPinned?: boolean }) {
    const member = await prisma.channelMember.findUnique({ where: { channelId_userId: { channelId, userId } } });
    if (!member) throw new Error('Bạn không phải thành viên của channel này!');
    return prisma.channelMember.update({ where: { id: member.id }, data: preferences });
  }

  private async getChannelWithPermissionCheck(channelId: string, userId: string, requiredRoles: ChannelMemberRole[]) {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { members: true } });
    if (!channel) throw new Error('Không tìm thấy channel!');

    const channelMember = channel.members.find(m => m.userId === userId);
    const workspaceMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
    });
    const hasPermission =
      (channelMember && requiredRoles.includes(channelMember.role)) ||
      (workspaceMember && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(workspaceMember.role));
    if (!hasPermission) throw new Error('Bạn không có quyền thực hiện hành động này!');
    return channel;
  }
}

export const channelService = new ChannelService();
