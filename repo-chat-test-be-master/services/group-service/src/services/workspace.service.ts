// services/group-service/src/services/workspace.service.ts
// WS-01, WS-02, WS-09: Workspace management

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import type { WorkspaceRole } from '@prisma/client';

// Types
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
  /**
   * WS-01: Create workspace
   */
  async createWorkspace(data: CreateWorkspaceInput, userId: string) {
    const { name, description, icon, slug, isPublic, allowGuestAccess } = data;

    if (!name || name.trim().length < 2) {
      throw new Error('Tên workspace phải có ít nhất 2 ký tự!');
    }

    // Generate slug if not provided
    const workspaceSlug = slug || this.generateSlug(name);

    // Check slug uniqueness
    const existingSlug = await prisma.workspace.findUnique({
      where: { slug: workspaceSlug },
    });

    if (existingSlug) {
      throw new Error('Slug đã tồn tại! Vui lòng chọn slug khác.');
    }

    // Create workspace with owner as first member
    const workspace = await prisma.workspace.create({
      data: {
        name: name.trim(),
        description: description?.trim(),
        icon,
        slug: workspaceSlug,
        ownerId: userId,
        isPublic: isPublic ?? false,
        allowGuestAccess: allowGuestAccess ?? false,
        members: {
          create: {
            userId,
            role: 'OWNER',
          },
        },
      },
      include: {
        members: true,
      },
    });

    // Publish event
    await publishEvent(EventSubjects.WORKSPACE_CREATED, {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdBy: userId,
      createdAt: workspace.createdAt.toISOString(),
    });

    logger.info({ workspaceId: workspace.id }, 'Workspace created');

    return workspace;
  }

  /**
   * WS-02: Update workspace settings
   */
  async updateWorkspace(id: string, data: UpdateWorkspaceInput, userId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { members: true },
    });

    if (!workspace) {
      throw new Error('Không tìm thấy workspace!');
    }

    // Check permission: OWNER or ADMIN
    const member = workspace.members.find(m => m.userId === userId);
    if (!member || !['OWNER', 'ADMIN'].includes(member.role)) {
      throw new Error('Bạn không có quyền chỉnh sửa workspace này!');
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.description !== undefined) updateData.description = data.description?.trim();
    if (data.icon !== undefined) updateData.icon = data.icon;
    if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;
    if (data.allowGuestAccess !== undefined) updateData.allowGuestAccess = data.allowGuestAccess;

    const updated = await prisma.workspace.update({
      where: { id },
      data: updateData,
    });

    logger.info({ workspaceId: id }, 'Workspace updated');

    return updated;
  }

  /**
   * Get workspace by ID or slug
   */
  async getWorkspace(idOrSlug: string, userId: string) {
    const workspace = await prisma.workspace.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      include: {
        members: {
          select: {
            id: true,
            userId: true,
            role: true,
            joinedAt: true,
          },
        },
        channels: {
          where: { isArchived: false },
          select: {
            id: true,
            name: true,
            type: true,
            isDefault: true,
          },
        },
        categories: {
          orderBy: { position: 'asc' },
        },
        _count: {
          select: {
            members: true,
            channels: true,
          },
        },
      },
    });

    if (!workspace) {
      throw new Error('Không tìm thấy workspace!');
    }

    // Check access
    const isMember = workspace.members.some(m => m.userId === userId);
    if (!isMember && !workspace.isPublic) {
      throw new Error('Bạn không có quyền xem workspace này!');
    }

    return workspace;
  }

  /**
   * List user's workspaces
   */
  async getUserWorkspaces(userId: string) {
    const workspaces = await prisma.workspace.findMany({
      where: {
        members: {
          some: { userId },
        },
      },
      include: {
        _count: {
          select: {
            members: true,
            channels: true,
          },
        },
        members: {
          where: { userId },
          select: { role: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return workspaces.map(ws => ({
      id: ws.id,
      name: ws.name,
      description: ws.description,
      icon: ws.icon,
      slug: ws.slug,
      isPublic: ws.isPublic,
      myRole: ws.members[0]?.role,
      memberCount: ws._count.members,
      channelCount: ws._count.channels,
      updatedAt: ws.updatedAt,
    }));
  }

  /**
   * WS-09: Add member to workspace
   */
  async addMember(workspaceId: string, targetUserId: string, role: WorkspaceRole, inviterId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: true },
    });

    if (!workspace) {
      throw new Error('Không tìm thấy workspace!');
    }

    // Check inviter permission
    const inviter = workspace.members.find(m => m.userId === inviterId);
    if (!inviter || !['OWNER', 'ADMIN'].includes(inviter.role)) {
      throw new Error('Bạn không có quyền thêm thành viên!');
    }

    // Check if already member
    const existing = workspace.members.find(m => m.userId === targetUserId);
    if (existing) {
      throw new Error('Người dùng đã là thành viên!');
    }

    // Cannot add someone with higher role than yourself
    const roleHierarchy = ['GUEST', 'MEMBER', 'ADMIN', 'OWNER'];
    if (roleHierarchy.indexOf(role) > roleHierarchy.indexOf(inviter.role)) {
      throw new Error('Không thể gán role cao hơn quyền của bạn!');
    }

    const member = await prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId: targetUserId,
        role,
        invitedBy: inviterId,
      },
    });

    // Auto-join default channels
    await this.autoJoinDefaultChannels(workspaceId, targetUserId);

    // Publish event
    await publishEvent(EventSubjects.WORKSPACE_MEMBER_ADDED, {
      workspaceId,
      userId: targetUserId,
      role,
      invitedBy: inviterId,
    });

    logger.info({ workspaceId, userId: targetUserId }, 'Member added to workspace');

    return member;
  }

  /**
   * WS-09: Remove member from workspace
   */
  async removeMember(workspaceId: string, targetUserId: string, removerId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: true },
    });

    if (!workspace) {
      throw new Error('Không tìm thấy workspace!');
    }

    const remover = workspace.members.find(m => m.userId === removerId);
    const target = workspace.members.find(m => m.userId === targetUserId);

    if (!target) {
      throw new Error('Người dùng không phải thành viên!');
    }

    // Self-leave is always allowed (except owner)
    if (targetUserId === removerId) {
      if (target.role === 'OWNER') {
        throw new Error('Owner không thể rời workspace! Vui lòng chuyển quyền trước.');
      }
    } else {
      // Kicking someone else requires OWNER/ADMIN
      if (!remover || !['OWNER', 'ADMIN'].includes(remover.role)) {
        throw new Error('Bạn không có quyền xóa thành viên!');
      }

      // Cannot remove someone with equal or higher role
      const roleHierarchy = ['GUEST', 'MEMBER', 'ADMIN', 'OWNER'];
      if (roleHierarchy.indexOf(target.role) >= roleHierarchy.indexOf(remover.role)) {
        throw new Error('Không thể xóa thành viên có quyền cao hơn hoặc bằng!');
      }
    }

    await prisma.workspaceMember.delete({
      where: { id: target.id },
    });

    // Also remove from all channels in this workspace
    await prisma.channelMember.deleteMany({
      where: {
        userId: targetUserId,
        channel: { workspaceId },
      },
    });

    // Publish event
    await publishEvent(EventSubjects.WORKSPACE_MEMBER_REMOVED, {
      workspaceId,
      userId: targetUserId,
      removedBy: removerId,
      isSelfLeave: targetUserId === removerId,
    });

    logger.info({ workspaceId, userId: targetUserId }, 'Member removed from workspace');

    return { removed: true };
  }

  /**
   * Update member role
   */
  async updateMemberRole(workspaceId: string, targetUserId: string, newRole: WorkspaceRole, updaterId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: true },
    });

    if (!workspace) {
      throw new Error('Không tìm thấy workspace!');
    }

    const updater = workspace.members.find(m => m.userId === updaterId);
    const target = workspace.members.find(m => m.userId === targetUserId);

    if (!target) {
      throw new Error('Người dùng không phải thành viên!');
    }

    // Only OWNER can change roles (or ADMIN can change MEMBER/GUEST)
    if (!updater) {
      throw new Error('Bạn không có quyền!');
    }

    const roleHierarchy = ['GUEST', 'MEMBER', 'ADMIN', 'OWNER'];

    // Cannot change to role higher than yourself
    if (roleHierarchy.indexOf(newRole) >= roleHierarchy.indexOf(updater.role)) {
      throw new Error('Không thể gán role cao hơn hoặc bằng quyền của bạn!');
    }

    // Cannot change role of someone with equal or higher role
    if (roleHierarchy.indexOf(target.role) >= roleHierarchy.indexOf(updater.role)) {
      throw new Error('Không thể thay đổi role của người có quyền cao hơn hoặc bằng!');
    }

    // Transfer ownership special case
    if (newRole === 'OWNER') {
      if (updater.role !== 'OWNER') {
        throw new Error('Chỉ Owner mới có thể chuyển quyền ownership!');
      }

      // Demote current owner to ADMIN
      await prisma.workspaceMember.update({
        where: { id: updater.id },
        data: { role: 'ADMIN' },
      });

      // Update workspace ownerId
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { ownerId: targetUserId },
      });
    }

    const updated = await prisma.workspaceMember.update({
      where: { id: target.id },
      data: { role: newRole },
    });

    logger.info({ workspaceId, userId: targetUserId, newRole }, 'Member role updated');

    return updated;
  }

  /**
   * Get workspace members with pagination
   */
  async getMembers(workspaceId: string, options: PaginationOptions = {}) {
    const { page = 1, limit = 50 } = options;
    const skip = (page - 1) * limit;

    const [members, total] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId },
        skip,
        take: limit,
        orderBy: [
          { role: 'desc' }, // OWNER first
          { joinedAt: 'asc' },
        ],
      }),
      prisma.workspaceMember.count({ where: { workspaceId } }),
    ]);

    return {
      items: members,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Delete workspace
   */
  async deleteWorkspace(id: string, userId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { members: true },
    });

    if (!workspace) {
      throw new Error('Không tìm thấy workspace!');
    }

    // Only OWNER can delete
    const member = workspace.members.find(m => m.userId === userId);
    if (!member || member.role !== 'OWNER') {
      throw new Error('Chỉ Owner mới có thể xóa workspace!');
    }

    await prisma.workspace.delete({
      where: { id },
    });

    // Publish event
    await publishEvent(EventSubjects.WORKSPACE_DELETED, {
      id,
      deletedBy: userId,
    });

    logger.info({ workspaceId: id }, 'Workspace deleted');

    return { deleted: true };
  }

  /**
   * Auto-join default channels when user joins workspace
   */
  private async autoJoinDefaultChannels(workspaceId: string, userId: string) {
    const defaultChannels = await prisma.channel.findMany({
      where: {
        workspaceId,
        isDefault: true,
        isArchived: false,
      },
    });

    if (defaultChannels.length === 0) return;

    await prisma.channelMember.createMany({
      data: defaultChannels.map(ch => ({
        channelId: ch.id,
        userId,
        role: 'MEMBER',
      })),
      skipDuplicates: true,
    });

    logger.info({ workspaceId, userId, count: defaultChannels.length }, 'Auto-joined default channels');
  }

  /**
   * Generate URL-friendly slug from name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }
}

export const workspaceService = new WorkspaceService();
