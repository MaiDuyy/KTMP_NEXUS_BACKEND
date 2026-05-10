// services/messaging-service/src/services/workspace.service.ts
// Workspace management — migrated from group-service (import paths updated)

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { userorgClient } from '../lib/userorgClient.js';
import type { WorkspaceRole } from '@prisma/client';

interface CreateWorkspaceInput {
  name: string;
  description?: string;
  icon?: string;
  slug?: string;
  isPublic?: boolean;
  allowGuestAccess?: boolean;
}

interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  icon?: string;
  isPublic?: boolean;
  allowGuestAccess?: boolean;
}

interface PaginationOptions {
  page?: number;
  limit?: number;
}

export class WorkspaceService {
  async createWorkspace(data: CreateWorkspaceInput, userId: string) {
    const { name, description, icon, slug, isPublic, allowGuestAccess } = data;
    if (!name || name.trim().length < 2) throw new Error('Tên workspace phải có ít nhất 2 ký tự!');

    // Check quota before creating
    const quota = await userorgClient.validateWorkspaceQuota(userId);
    if (!quota.allowed) {
      throw new Error(`Bạn đã đạt giới hạn số lượng Workspace (${quota.used}/${quota.limit}). Vui lòng nâng cấp gói hoặc liên hệ quản trị viên.`);
    }

    const workspaceSlug = slug || this.generateSlug(name);
    const existingSlug = await prisma.workspace.findUnique({ where: { slug: workspaceSlug } });
    if (existingSlug) throw new Error('Slug đã tồn tại! Vui lòng chọn slug khác.');

    const workspace = await prisma.workspace.create({
      data: {
        name: name.trim(), description: description?.trim(), icon, slug: workspaceSlug,
        ownerId: userId, isPublic: isPublic ?? false, allowGuestAccess: allowGuestAccess ?? false,
        members: { create: { userId, role: 'WORKSPACE_OWNER' } },
      },
      include: { members: true },
    });

    // Create default #general channel
    await prisma.channel.create({
      data: {
        workspaceId: workspace.id,
        name: 'general',
        description: 'Channel mặc định cho tất cả thành viên',
        type: 'PUBLIC',
        isDefault: true,
        creatorId: userId,
        members: {
          create: {
            userId,
            role: 'CHANNEL_OWNER',
          }
        }
      }
    });

    await publishEvent(EventSubjects.WORKSPACE_CREATED, {
      id: workspace.id, name: workspace.name, slug: workspace.slug,
      createdBy: userId, createdAt: workspace.createdAt.toISOString(),
    });
    logger.info({ workspaceId: workspace.id }, 'Workspace created with #general channel');
    return workspace;
  }

  async updateWorkspace(id: string, data: UpdateWorkspaceInput, userId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const member = workspace.members.find(m => m.userId === userId);
    if (!member || !['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(member.role)) throw new Error('Bạn không có quyền chỉnh sửa workspace này!');

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.description !== undefined) updateData.description = data.description?.trim();
    if (data.icon !== undefined) updateData.icon = data.icon;
    if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;
    if (data.allowGuestAccess !== undefined) updateData.allowGuestAccess = data.allowGuestAccess;

    const updated = await prisma.workspace.update({ where: { id }, data: updateData });
    logger.info({ workspaceId: id }, 'Workspace updated');
    return updated;
  }

  async getWorkspace(idOrSlug: string, userId: string) {
    const workspace = await prisma.workspace.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        members: { select: { id: true, userId: true, role: true, joinedAt: true } },
        channels: { where: { isArchived: false }, select: { id: true, name: true, type: true, isDefault: true } },
        categories: { orderBy: { position: 'asc' } },
        _count: { select: { members: true, channels: true } },
      },
    });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const isMember = workspace.members.some(m => m.userId === userId);
    if (!isMember && !workspace.isPublic) throw new Error('Bạn không có quyền xem workspace này!');
    return workspace;
  }

  async getUserWorkspaces(userId: string) {
    const workspaces = await prisma.workspace.findMany({
      where: { 
        members: { some: { userId } },
        status: 'ACTIVE'
      },
      include: {
        _count: { select: { members: true, channels: true } },
        members: { where: { userId }, select: { role: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return workspaces.map(ws => ({
      id: ws.id, name: ws.name, description: ws.description, icon: ws.icon, slug: ws.slug,
      isPublic: ws.isPublic, myRole: ws.members[0]?.role,
      memberCount: ws._count.members, channelCount: ws._count.channels, updatedAt: ws.updatedAt,
    }));
  }

  async getDissolvedWorkspaces(userId: string) {
    const workspaces = await prisma.workspace.findMany({
      where: { 
        ownerId: userId,
        status: 'DISSOLVED'
      },
      include: {
        _count: { select: { members: true, channels: true } }
      },
      orderBy: { dissolvedAt: 'desc' },
    });

    return workspaces.map(ws => ({
      id: ws.id,
      name: ws.name,
      description: ws.description,
      icon: ws.icon,
      slug: ws.slug,
      dissolvedAt: ws.dissolvedAt,
      memberCount: ws._count.members,
      channelCount: ws._count.channels,
      retentionDays: ws.retentionDays
    }));
  }

  async addMember(workspaceId: string, targetUserId: string, roleInput: string, inviterId?: string) {
    // Robust role mapping
    let role: WorkspaceRole = 'WORKSPACE_MEMBER';
    const upperRole = (roleInput || '').toUpperCase();
    
    if (upperRole.includes('OWNER')) role = 'WORKSPACE_OWNER';
    else if (upperRole.includes('ADMIN') || upperRole.includes('MANAGER')) role = 'WORKSPACE_ADMIN';
    else if (upperRole.includes('GUEST')) role = 'WORKSPACE_GUEST';
    else role = 'WORKSPACE_MEMBER';

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    if (inviterId) {
      const inviter = workspace.members.find(m => m.userId === inviterId);
      if (!inviter || !['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(inviter.role)) throw new Error('Bạn không có quyền thêm thành viên!');

      const roleHierarchy = ['WORKSPACE_GUEST', 'WORKSPACE_MEMBER', 'WORKSPACE_ADMIN', 'WORKSPACE_OWNER'];
      if (roleHierarchy.indexOf(role) > roleHierarchy.indexOf(inviter.role)) throw new Error('Không thể gán role cao hơn quyền của bạn!');
    }

    const existing = workspace.members.find(m => m.userId === targetUserId);
    if (existing) throw new Error('Người dùng đã là thành viên!');

    const member = await prisma.workspaceMember.create({
      data: { workspaceId, userId: targetUserId, role, invitedBy: inviterId },
    });

    await this.autoJoinDefaultChannels(workspaceId, targetUserId);
    
    // Get all member IDs to notify via WS Gateway
    const allMemberIds = workspace.members.map(m => m.userId);
    if (!allMemberIds.includes(targetUserId)) allMemberIds.push(targetUserId);

    await publishEvent(EventSubjects.WORKSPACE_MEMBER_ADDED, { 
      workspaceId, 
      userId: targetUserId, 
      role, 
      invitedBy: inviterId,
      memberIds: allMemberIds
    });
    logger.info({ workspaceId, userId: targetUserId }, 'Member added to workspace');
    return member;
  }

  async removeMember(workspaceId: string, targetUserId: string, removerId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const remover = workspace.members.find(m => m.userId === removerId);
    const target = workspace.members.find(m => m.userId === targetUserId);
    if (!target) throw new Error('Người dùng không phải thành viên!');

    if (targetUserId === removerId) {
      if (target.role === 'WORKSPACE_OWNER') throw new Error('Owner không thể rời workspace! Vui lòng chuyển quyền trước.');
    } else {
      if (!remover || !['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(remover.role)) throw new Error('Bạn không có quyền xóa thành viên!');
      const roleHierarchy = ['WORKSPACE_GUEST', 'WORKSPACE_MEMBER', 'WORKSPACE_ADMIN', 'WORKSPACE_OWNER'];
      if (roleHierarchy.indexOf(target.role) >= roleHierarchy.indexOf(remover.role))
        throw new Error('Không thể xóa thành viên có quyền cao hơn hoặc bằng!');
    }

    await prisma.workspaceMember.delete({ where: { id: target.id } });
    await prisma.channelMember.deleteMany({ where: { userId: targetUserId, channel: { workspaceId } } });

    await publishEvent(EventSubjects.WORKSPACE_MEMBER_REMOVED, {
      workspaceId, userId: targetUserId, removedBy: removerId, isSelfLeave: targetUserId === removerId,
    });
    logger.info({ workspaceId, userId: targetUserId }, 'Member removed from workspace');
    return { success: true, removed: true };
  }

  async updateMemberRole(workspaceId: string, targetUserId: string, newRole: WorkspaceRole, updaterId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const updater = workspace.members.find(m => m.userId === updaterId);
    const target = workspace.members.find(m => m.userId === targetUserId);
    if (!target) throw new Error('Người dùng không phải thành viên!');
    if (!updater) throw new Error('Bạn không có quyền!');

    const roleHierarchy = ['WORKSPACE_GUEST', 'WORKSPACE_MEMBER', 'WORKSPACE_ADMIN', 'WORKSPACE_OWNER'];
    if (roleHierarchy.indexOf(newRole) >= roleHierarchy.indexOf(updater.role))
      throw new Error('Không thể gán role cao hơn hoặc bằng quyền của bạn!');
    if (roleHierarchy.indexOf(target.role) >= roleHierarchy.indexOf(updater.role))
      throw new Error('Không thể thay đổi role của người có quyền cao hơn hoặc bằng!');

    if (newRole === 'WORKSPACE_OWNER') {
      if (updater.role !== 'WORKSPACE_OWNER') throw new Error('Chỉ Owner mới có thể chuyển quyền ownership!');
      return await this.transferOwnership(workspaceId, targetUserId, updaterId);
    }

    const updated = await prisma.workspaceMember.update({ where: { id: target.id }, data: { role: newRole } });
    
    // Publish Real-time event
    const members = await this.getWorkspaceMembers(workspaceId);
    await publishEvent(EventSubjects.WORKSPACE_MEMBER_ROLE_UPDATED, {
      workspaceId,
      userId: targetUserId,
      role: newRole,
      updatedBy: updaterId,
      memberIds: members
    });

    logger.info({ workspaceId, userId: targetUserId, newRole }, 'Member role updated');
    return updated;
  }

  async transferOwnership(workspaceId: string, targetUserId: string, ownerId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    if (workspace.ownerId !== ownerId) throw new Error('Chỉ Owner hiện tại mới có quyền chuyển giao!');

    const targetMember = workspace.members.find(m => m.userId === targetUserId);
    if (!targetMember) throw new Error('Người nhận không phải thành viên của Workspace!');

    const oldOwnerMember = workspace.members.find(m => m.userId === ownerId);
    if (!oldOwnerMember) throw new Error('Lỗi dữ liệu: Không tìm thấy OWNER cũ!');

    return await prisma.$transaction(async (tx) => {
      // 1. Nâng cấp người mới thành OWNER
      await tx.workspaceMember.update({
        where: { id: targetMember.id },
        data: { role: 'WORKSPACE_OWNER' }
      });

      // 2. Hạ cấp người cũ thành ADMIN
      await tx.workspaceMember.update({
        where: { id: oldOwnerMember.id },
        data: { role: 'WORKSPACE_ADMIN' }
      });

      // 3. Cập nhật ownerId của Workspace
      const updatedWorkspace = await tx.workspace.update({
        where: { id: workspaceId },
        data: { ownerId: targetUserId }
      });

      // 4. Phát sự kiện
      const members = await this.getWorkspaceMembers(workspaceId);
      await publishEvent(EventSubjects.WORKSPACE_OWNER_TRANSFERRED, {
        workspaceId,
        oldOwnerId: ownerId,
        newOwnerId: targetUserId,
        memberIds: members
      });

      logger.info({ workspaceId, from: ownerId, to: targetUserId }, 'Ownership transferred');
      return updatedWorkspace;
    });
  }

  async getMembers(workspaceId: string, options: PaginationOptions = {}) {
    const { page = 1, limit = 50 } = options;
    const skip = (page - 1) * limit;

    const [members, total] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId }, skip, take: limit,
        orderBy: [{ role: 'desc' }, { joinedAt: 'asc' }],
      }),
      prisma.workspaceMember.count({ where: { workspaceId } }),
    ]);

    const userIds = members.map(m => m.userId);
    const userMap = await userorgClient.getUsers(userIds);

    const items = members.map(member => ({
      ...member,
      user: userMap.get(member.userId) || { name: 'Người dùng hệ thống', avatar: null, email: null }
    }));

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async dissolveWorkspace(id: string, userId: string, workspaceNameConfirm: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');
    
    if (workspace.name !== workspaceNameConfirm) {
      throw new Error('Xác nhận tên Workspace không chính xác!');
    }

    const member = workspace.members.find(m => m.userId === userId);
    if (!member || member.role !== 'WORKSPACE_OWNER') {
      throw new Error('Chỉ Owner mới có quyền giải tán Workspace!');
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Update workspace status
      const updated = await tx.workspace.update({
        where: { id },
        data: {
          status: 'DISSOLVED',
          dissolvedAt: new Date(),
          dissolvedBy: userId,
        },
      });

      // 2. Soft delete groups (chats in this workspace)
      await tx.chat.updateMany({
        where: { workspaceId: id, isGroup: true },
        data: { status: 'DISSOLVED' },
      });

      // 3. Update member status
      await tx.workspaceMember.updateMany({
        where: { workspaceId: id },
        data: {
          leftAt: new Date(),
          leftReason: 'WORKSPACE_DISSOLVED',
        },
      });

      // 4. Cancel pending invites
      await tx.workspaceInvite.updateMany({
        where: { workspaceId: id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      
      const members = workspace.members.map(m => m.userId);
      await publishEvent(EventSubjects.WORKSPACE_DISSOLVED, { 
        workspaceId: id, 
        name: workspace.name,
        dissolvedBy: userId,
        memberIds: members 
      });
      logger.info({ workspaceId: id }, 'Workspace dissolved (soft deleted)');
      return updated;
    });
  }

  async restoreWorkspace(id: string, userId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');
    if (workspace.ownerId !== userId) throw new Error('Chỉ Owner mới có quyền khôi phục Workspace!');
    if (workspace.status !== 'DISSOLVED') throw new Error('Workspace không ở trạng thái bị giải tán!');

    return await prisma.$transaction(async (tx) => {
      const updated = await tx.workspace.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          dissolvedAt: null,
          dissolvedBy: null,
        },
      });

      await tx.chat.updateMany({
        where: { workspaceId: id, isGroup: true, status: 'DISSOLVED' },
        data: { status: 'ACTIVE' },
      });

      await tx.workspaceMember.updateMany({
        where: { workspaceId: id, leftReason: 'WORKSPACE_DISSOLVED' },
        data: {
          leftAt: null,
          leftReason: null,
        },
      });

      logger.info({ workspaceId: id }, 'Workspace restored');
      
      const members = await tx.workspaceMember.findMany({
        where: { workspaceId: id },
        select: { userId: true }
      });

      await publishEvent(EventSubjects.WORKSPACE_RESTORED, { 
        workspaceId: id, 
        name: updated.name,
        restoredBy: userId,
        memberIds: members.map(m => m.userId)
      });

      return updated;
    });
  }

  async getWorkspaceMetadata(id: string) {
    return prisma.workspace.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, ownerId: true, dissolvedAt: true, retentionDays: true, slug: true },
    });
  }

  async getWorkspaceMembers(workspaceId: string) {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true },
    });
    return members.map(m => m.userId);
  }

  async getUserDMPartners(userId: string) {
    const chats = await prisma.chat.findMany({
      where: {
        isGroup: false,
        participants: { some: { accountId: userId } }
      },
      include: { participants: true }
    });

    const partnerIds = new Set<string>();
    for (const chat of chats) {
      for (const participant of chat.participants) {
        if (participant.accountId !== userId) {
          partnerIds.add(participant.accountId);
        }
      }
    }
    return Array.from(partnerIds);
  }

  async checkSharedActiveWorkspace(user1Id: string, user2Id: string) {
    const sharedCount = await prisma.workspace.count({
      where: {
        status: 'ACTIVE',
        members: { some: { userId: user1Id } },
        AND: {
          members: { some: { userId: user2Id } }
        }
      }
    });
    return { hasSharedActiveWorkspace: sharedCount > 0, sharedCount };
  }

  async deleteWorkspace(id: string, userId: string) {
    // Keep this for legacy or super-admin hard delete
    const workspace = await prisma.workspace.findUnique({ where: { id }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');
    const member = workspace.members.find(m => m.userId === userId);
    if (!member || member.role !== 'WORKSPACE_OWNER') throw new Error('Chỉ Owner mới có quyền xóa Workspace!');

    await prisma.workspace.delete({ where: { id } });
    await publishEvent(EventSubjects.WORKSPACE_DELETED, { id, deletedBy: userId });
    logger.info({ workspaceId: id }, 'Workspace hard deleted');
    return { success: true, deleted: true };
  }

  async leaveWorkspace(workspaceId: string, userId: string) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } }
    });
    if (!member) throw new Error('Thành viên không tồn tại trong Workspace!');
    if (member.role === 'WORKSPACE_OWNER') throw new Error('Owner không thể rời Workspace! Hãy giải tán hoặc chuyển quyền sở hữu.');

    const updated = await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: {
        leftAt: new Date(),
        leftReason: 'SELF_LEFT',
      }
    });

    const members = await this.getWorkspaceMembers(workspaceId);
    await publishEvent(EventSubjects.WORKSPACE_MEMBER_LEFT, {
      workspaceId,
      userId,
      memberIds: members,
      reason: 'SELF_LEFT'
    });

    return updated;
  }

  async kickMember(workspaceId: string, targetUserId: string, actorId: string) {
    const [targetMember, actorMember] = await Promise.all([
      prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } } }),
      prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: actorId } } })
    ]);

    if (!targetMember) throw new Error('Thành viên mục tiêu không tồn tại!');
    if (!actorMember || (actorMember.role !== 'WORKSPACE_OWNER' && actorMember.role !== 'WORKSPACE_ADMIN')) {
      throw new Error('Bạn không có quyền kick thành viên!');
    }
    if (targetMember.role === 'WORKSPACE_OWNER') throw new Error('Không thể kick Owner!');

    const updated = await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      data: {
        leftAt: new Date(),
        leftReason: 'KICKED',
      }
    });

    const members = await this.getWorkspaceMembers(workspaceId);
    await publishEvent(EventSubjects.WORKSPACE_MEMBER_KICKED, {
      workspaceId,
      userId: targetUserId,
      memberIds: members,
      reason: 'KICKED',
      kickedBy: actorId
    });

    return updated;
  }

  async getExpiredDissolvedWorkspaces() {
    const dissolved = await prisma.workspace.findMany({
      where: { status: 'DISSOLVED' },
      select: { id: true, dissolvedAt: true, retentionDays: true }
    });

    const expiredIds: string[] = [];
    const now = new Date();

    for (const ws of dissolved) {
      if (ws.dissolvedAt) {
        const expiryDate = new Date(ws.dissolvedAt);
        expiryDate.setDate(expiryDate.getDate() + (ws.retentionDays || 30));
        if (now > expiryDate) {
          expiredIds.push(ws.id);
        }
      }
    }

    return expiredIds;
  }

  async deletePermanently(workspaceId: string) {
    return await prisma.$transaction(async (tx) => {
      // 1. Delete all chats/messages
      const chats = await tx.chat.findMany({ where: { workspaceId } });
      const chatIds = chats.map(c => c.id);

      await tx.message.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.chat.deleteMany({ where: { workspaceId } });

      // 2. Delete channels
      await tx.channel.deleteMany({ where: { workspaceId } });

      // 3. Delete invites
      await tx.workspaceInvite.deleteMany({ where: { workspaceId } });

      // 4. Delete members
      await tx.workspaceMember.deleteMany({ where: { workspaceId } });

      // 5. Delete workspace itself
      await tx.workspace.delete({ where: { id: workspaceId } });

      logger.info({ workspaceId }, 'Workspace permanently deleted by Cron Job');
      return true;
    });
  }

  async archiveOneToOneChat(user1Id: string, user2Id: string) {
    const chat = await prisma.chat.findFirst({
      where: {
        isGroup: false,
        participants: {
          some: { accountId: user1Id }
        },
        AND: {
          participants: { some: { accountId: user2Id } }
        }
      },
      include: { participants: true }
    });

    if (chat) {
      await prisma.chat.update({
        where: { id: chat.id },
        data: { status: 'ARCHIVED' }
      });
      logger.info({ chatId: chat.id, user1Id, user2Id }, '1-1 Chat archived');
      return true;
    }
    return false;
  }

  async countWorkspacesByOwner(ownerId: string): Promise<number> {
    return prisma.workspace.count({
      where: { ownerId, status: 'ACTIVE' }
    });
  }

  // ================= INVITATION FLOW =================

  /**
   * Tạo lời mời mới gửi qua Email
   */
  async inviteMember(workspaceId: string, inviterId: string, email: string, role: WorkspaceRole = 'WORKSPACE_MEMBER') {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    // RBAC: Chỉ OWNER và ADMIN mới có thể mời thành viên
    const inviter = workspace.members.find(m => m.userId === inviterId);
    if (!inviter || !['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(inviter.role)) {
      throw new Error('Bạn không có quyền mời thành viên vào Workspace này!');
    }

    // Kiểm tra xem email này đã có tài khoản chưa để hỗ trợ Real-time notification
    const existingUser = await userorgClient.getUserByEmail(email);
    const inviteeId = existingUser ? existingUser.id : null;

    // Tạo token bảo mật
    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // Hết hạn sau 7 ngày

    const invite = await prisma.workspaceInvite.create({
      data: {
        workspaceId,
        email: email.toLowerCase(),
        token,
        role,
        inviterId,
        expiresAt,
      }
    });

    // Phát sự kiện NATS để Notification Service gửi Email + WS Gateway thông báo realtime
    await publishEvent(EventSubjects.WORKSPACE_INVITE_CREATED, {
      inviteId: invite.id,
      workspaceId,
      workspaceName: workspace.name,
      email: invite.email,
      token: invite.token,
      role: invite.role,
      inviterId,
      inviteeId, // Thêm inviteeId nếu user đã tồn tại
    });

    logger.info({ workspaceId, email, inviteId: invite.id }, 'Workspace invitation created');
    return { success: true, message: 'Đã gửi lời mời thành công!' };
  }

  async getWorkspaceInvites(workspaceId: string, userId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const member = workspace.members.find(m => m.userId === userId);
    if (!member || !['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(member.role)) {
      throw new Error('Bạn không có quyền xem danh sách lời mời!');
    }

    const invites = await prisma.workspaceInvite.findMany({
      where: { 
        workspaceId, 
        status: { in: ['PENDING', 'REJECTED'] } 
      },
      orderBy: { createdAt: 'desc' },
    });

    return invites;
  }

  async cancelInvite(inviteId: string, userId: string) {
    const invite = await prisma.workspaceInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new Error('Không tìm thấy lời mời!');

    const workspace = await prisma.workspace.findUnique({ 
      where: { id: invite.workspaceId }, 
      include: { members: true } 
    });
    
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const member = workspace.members.find(m => m.userId === userId);
    if (!member || !['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(member.role)) {
      throw new Error('Bạn không có quyền hủy lời mời!');
    }

    await prisma.workspaceInvite.update({
      where: { id: inviteId },
      data: { status: 'CANCELLED' },
    });

    await publishEvent(EventSubjects.WORKSPACE_INVITE_CANCELLED, {
      workspaceId: invite.workspaceId,
      inviteId: invite.id,
      cancelledBy: userId,
      memberIds: workspace.members.map(m => m.userId)
    });

    return { success: true, message: 'Đã hủy lời mời!' };
  }

  /**
   * Kiểm tra tính hợp lệ của Token
   */
  async validateInviteToken(token: string) {
    const invite = await prisma.workspaceInvite.findUnique({
      where: { token },
      include: { workspace: { select: { name: true, slug: true } } }
    });

    if (!invite) throw new Error('Lời mời không tồn tại hoặc link đã bị thay đổi!');
    if (invite.status !== 'PENDING') throw new Error('Lời mời này đã được sử dụng hoặc không còn hiệu lực!');
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      await prisma.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'EXPIRED' } });
      throw new Error('Lời mời đã hết hạn!');
    }

    return invite;
  }

  /**
   * Từ chối lời mời
   */
  async rejectInvite(token: string) {
    const invite = await prisma.workspaceInvite.findUnique({
      where: { token },
    });

    if (!invite) throw new Error('Lời mời không tồn tại!');
    if (invite.status !== 'PENDING') throw new Error('Lời mời này không còn ở trạng thái chờ!');

    await prisma.workspaceInvite.update({
      where: { token },
      data: { status: 'REJECTED' }
    });

    // Notify inviter or workspace admins?
    await publishEvent(EventSubjects.WORKSPACE_INVITE_REJECTED, {
      workspaceId: invite.workspaceId,
      email: invite.email,
      inviteId: invite.id,
      inviterId: invite.inviterId
    });

    return { success: true, message: 'Đã từ chối lời mời thành công!' };
  }

  /**
   * Chấp nhận lời mời và gia nhập Workspace
   */
  async acceptInvite(token: string, userId: string) {
    const invite = await this.validateInviteToken(token);

    // Bắt đầu Transaction
    return await prisma.$transaction(async (tx) => {
      // 1. Kiểm tra xem đã là thành viên chưa
      const existingMember = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } }
      });

      if (existingMember) {
        await tx.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'ACCEPTED' } });
        return { success: true, workspaceId: invite.workspaceId, message: 'Bạn đã là thành viên!' };
      }

      // 2. Tạo bản ghi thành viên mới
      const member = await tx.workspaceMember.create({
        data: {
          workspaceId: invite.workspaceId,
          userId,
          role: invite.role,
          invitedBy: invite.inviterId
        }
      });

      // 3. Cập nhật trạng thái lời mời
      await tx.workspaceInvite.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED' }
      });

      // 4. Tự động tham gia các channel mặc định
      const defaultChannels = await tx.channel.findMany({
        where: { workspaceId: invite.workspaceId, isDefault: true, isArchived: false },
      });
      
      if (defaultChannels.length > 0) {
        await tx.channelMember.createMany({
          data: defaultChannels.map(ch => ({ channelId: ch.id, userId, role: 'CHANNEL_MEMBER' as const })),
          skipDuplicates: true,
        });
      }

      // 5. Phát sự kiện thành công
      const members = await tx.workspaceMember.findMany({
        where: { workspaceId: invite.workspaceId },
        select: { userId: true }
      });

      await publishEvent(EventSubjects.WORKSPACE_INVITE_ACCEPTED, {
        workspaceId: invite.workspaceId,
        userId,
        inviteId: invite.id,
        inviterId: invite.inviterId,
        memberIds: members.map(m => m.userId)
      });

      logger.info({ workspaceId: invite.workspaceId, userId }, 'Invitation accepted');
      return { success: true, workspaceId: invite.workspaceId, slug: invite.workspace.slug };
    });
  }

  private async autoJoinDefaultChannels(workspaceId: string, userId: string) {
    const defaultChannels = await prisma.channel.findMany({
      where: { workspaceId, isDefault: true, isArchived: false },
    });
    if (defaultChannels.length === 0) return;

    await prisma.channelMember.createMany({
      data: defaultChannels.map(ch => ({ channelId: ch.id, userId, role: 'CHANNEL_MEMBER' as const })),
      skipDuplicates: true,
    });
    logger.info({ workspaceId, userId, count: defaultChannels.length }, 'Auto-joined default channels');
  }

  private generateSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
  }

  async checkMembership(workspaceId: string, userId: string) {
    return prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
    });
  }

  async dissolveGroups(workspaceId: string) {
    const result = await prisma.chat.updateMany({
      where: { workspaceId, isGroup: true, status: 'ACTIVE' },
      data: { status: 'DISSOLVED' },
    });
    logger.info({ workspaceId, count: result.count }, 'Workspace groups dissolved');
    return result.count;
  }

  async restoreGroups(workspaceId: string) {
    const result = await prisma.chat.updateMany({
      where: { workspaceId, isGroup: true, status: 'DISSOLVED' },
      data: { status: 'ACTIVE' },
    });
    logger.info({ workspaceId, count: result.count }, 'Workspace groups restored');
    return result.count;
  }
}

export const workspaceService = new WorkspaceService();
