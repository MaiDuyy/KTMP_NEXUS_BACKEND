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
  departmentId?: string;
}

interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  icon?: string;
  isPublic?: boolean;
  allowGuestAccess?: boolean;
  departmentId?: string;
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
        departmentId: data.departmentId || null,
        members: { create: { userId, role: 'WORKSPACE_OWNER' } },
      },
      include: { members: true },
    });

    // Create default #general channel
    const channel = await prisma.channel.create({
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

    // Mirror to Chat table for messaging support
    await prisma.chat.create({
      data: {
        id: channel.id,
        isGroup: true,
        name: channel.name,
        workspaceId: workspace.id,
        joinPolicy: 'PUBLIC',
        status: 'ACTIVE',
        participants: {
          create: {
            accountId: userId,
            role: 'CHANNEL_OWNER',
          }
        }
      }
    }).catch((e) => logger.error({ err: e.message }, 'Failed to mirror default Channel to Chat'));

    await publishEvent(EventSubjects.WORKSPACE_CREATED, {
      id: workspace.id, name: workspace.name, slug: workspace.slug,
      createdBy: userId, createdAt: workspace.createdAt.toISOString(),
      departmentId: workspace.departmentId || undefined,
    });
    logger.info({ workspaceId: workspace.id }, 'Workspace created with #general channel');
    return workspace;
  }

  async updateWorkspace(id: string, data: UpdateWorkspaceInput, userId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const { globalRole, assignedWorkspaceIds, assignedDepartmentIds } = await userorgClient.getUserRolesAndScopes(userId);
    const isSystemAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(globalRole);
    const isSystemWorkspaceManager = globalRole === 'WORKSPACE_MANAGER';
    
    const member = workspace.members.find(m => m.userId === userId && m.leftAt === null);
    
    const isAssigned = assignedWorkspaceIds.includes(workspace.id) || 
                       (workspace.departmentId && assignedDepartmentIds.includes(workspace.departmentId));

    const hasAdminAccess = (member && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(member.role)) || 
                           isSystemAdmin || 
                           (isSystemWorkspaceManager && (member !== undefined || isAssigned)) ||
                           isAssigned ||
                           await userorgClient.checkWorkspaceAccess(userId, workspace.id, workspace.departmentId, workspace.createdAt.toISOString());
    if (!hasAdminAccess) throw new Error('Bạn không có quyền chỉnh sửa workspace này!');

    // Enforce CHANGE_DEPT_ASSIGNMENT restriction: only System Admins or Workspace Owners can change department assignment
    if (data.departmentId !== undefined && data.departmentId !== workspace.departmentId) {
      const isOwner = member && member.role === 'WORKSPACE_OWNER';
      if (!isSystemAdmin && !isOwner) {
        throw new Error('Chỉ Trưởng hệ thống hoặc Chủ sở hữu Workspace mới có quyền thay đổi phòng ban liên kết!');
      }
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.description !== undefined) updateData.description = data.description?.trim();
    if (data.icon !== undefined) updateData.icon = data.icon;
    if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;
    if (data.allowGuestAccess !== undefined) updateData.allowGuestAccess = data.allowGuestAccess;
    if (data.departmentId !== undefined) updateData.departmentId = data.departmentId || null;

    const oldDepartmentId = workspace.departmentId;

    const updated = await prisma.workspace.update({ where: { id }, data: updateData });

    // Broadcast to all workspace members via ws-gateway
    const memberIds = workspace.members.map(m => m.userId);
    await publishEvent(EventSubjects.WORKSPACE_UPDATED, {
      id: updated.id,
      memberIds,
      updates: {
        name: updated.name,
        description: updated.description,
        icon: updated.icon,
        isPublic: updated.isPublic,
        departmentId: updated.departmentId,
        oldDepartmentId: oldDepartmentId,
      },
      updatedBy: userId,
    }).catch(err => logger.warn({ err: err.message }, 'NATS publish workspace.updated failed (non-fatal)'));

    logger.info({ workspaceId: id }, 'Workspace updated + event published');
    return updated;
  }

  async getWorkspace(idOrSlug: string, userId: string) {
    const workspace = await prisma.workspace.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        members: { 
          where: { leftAt: null },
          select: { id: true, userId: true, role: true, joinedAt: true } 
        },
        channels: { where: { isArchived: false }, select: { id: true, name: true, type: true, isDefault: true } },
        categories: { orderBy: { position: 'asc' } },
        _count: { 
          select: { 
            members: { where: { leftAt: null } }, 
            channels: true 
          } 
        },
      },
    });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const isMember = workspace.members.some(m => m.userId === userId);
    if (!isMember && !workspace.isPublic) {
      const hasRbacAccess = await userorgClient.checkWorkspaceAccess(
        userId,
        workspace.id,
        workspace.departmentId,
        workspace.createdAt.toISOString()
      );
      if (!hasRbacAccess) {
        throw new Error('Bạn không có quyền xem workspace này!');
      }
    }
    return workspace;
  }

  async getUserWorkspaces(userId: string) {
    const { globalRole, assignedWorkspaceIds, assignedDepartmentIds } = await userorgClient.getUserRolesAndScopes(userId);

    const isSystemAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(globalRole);

    let whereClause: any = { status: 'ACTIVE' };

    if (!isSystemAdmin) {
      whereClause.OR = [
        { members: { some: { userId, leftAt: null } } },
        { id: { in: assignedWorkspaceIds } }
      ];
      
      if (assignedDepartmentIds.length > 0) {
        whereClause.OR.push({ departmentId: { in: assignedDepartmentIds } });
      }
    }

    const workspaces = await prisma.workspace.findMany({
      where: whereClause,
      include: {
        _count: { 
          select: { 
            members: { where: { leftAt: null } }, 
            channels: true 
          } 
        },
        members: { where: { userId, leftAt: null }, select: { role: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return workspaces.map(ws => {
      let myRole = ws.members[0]?.role || null;
      
      const isAssigned = assignedWorkspaceIds.includes(ws.id) || 
                         (ws.departmentId && assignedDepartmentIds.includes(ws.departmentId));
      
      const isSystemWorkspaceManager = globalRole === 'WORKSPACE_MANAGER';
      
      const shouldHaveAdmin = isSystemAdmin || 
                              (isSystemWorkspaceManager && (ws.members.length > 0 || isAssigned)) ||
                              isAssigned;

      if (shouldHaveAdmin && myRole !== 'WORKSPACE_OWNER') {
        myRole = 'WORKSPACE_ADMIN';
      }

      return {
        id: ws.id, name: ws.name, description: ws.description, icon: ws.icon, slug: ws.slug,
        isPublic: ws.isPublic, myRole,
        memberCount: ws._count.members, channelCount: ws._count.channels, updatedAt: ws.updatedAt,
        departmentId: ws.departmentId,
      };
    });
  }

  async getWorkspacesByDepartment(departmentId: string, userId: string) {
    // Return all ACTIVE workspaces in this department where the user is a member (or workspace is public)
    const workspaces = await prisma.workspace.findMany({
      where: {
        departmentId,
        status: 'ACTIVE',
        OR: [
          { members: { some: { userId, leftAt: null } } },
          { isPublic: true },
        ],
      },
      include: {
        _count: {
          select: {
            members: { where: { leftAt: null } },
            channels: true,
          },
        },
        members: { where: { userId, leftAt: null }, select: { role: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return workspaces.map(ws => ({
      id: ws.id, name: ws.name, description: ws.description, icon: ws.icon, slug: ws.slug,
      isPublic: ws.isPublic, myRole: ws.members[0]?.role ?? null,
      memberCount: ws._count.members, channelCount: ws._count.channels, updatedAt: ws.updatedAt,
      departmentId: ws.departmentId,
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

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: true },  // load all (including soft-deleted) for full context
    });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    if (workspace.departmentId) {
      const belongs = await userorgClient.checkUserDepartment(targetUserId, workspace.departmentId);
      if (!belongs) {
        throw new Error('Người dùng không thuộc phòng ban liên kết với Workspace này!');
      }
    }

    // Only active members (leftAt: null) can be inviters
    const activeMembers = workspace.members.filter(m => m.leftAt === null);

    if (inviterId) {
      const inviter = activeMembers.find(m => m.userId === inviterId);
      
      const { globalRole, assignedWorkspaceIds, assignedDepartmentIds } = await userorgClient.getUserRolesAndScopes(inviterId);
      const isSystemAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(globalRole);
      const isSystemWorkspaceManager = globalRole === 'WORKSPACE_MANAGER';
      const isAssigned = assignedWorkspaceIds.includes(workspace.id) || 
                         (workspace.departmentId && assignedDepartmentIds.includes(workspace.departmentId));

      const hasManagerAccess = (inviter && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(inviter.role)) ||
                               isSystemAdmin ||
                               (isSystemWorkspaceManager && (inviter !== undefined || isAssigned)) ||
                               isAssigned ||
                               await userorgClient.checkWorkspaceAccess(inviterId, workspace.id, workspace.departmentId, workspace.createdAt.toISOString());
      if (!hasManagerAccess) throw new Error('Bạn không có quyền thêm thành viên!');

      const roleHierarchy = ['WORKSPACE_GUEST', 'WORKSPACE_MEMBER', 'WORKSPACE_ADMIN', 'WORKSPACE_OWNER'];
      const inviterMaxRole = (inviter && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(inviter.role)) || hasManagerAccess
        ? 'WORKSPACE_ADMIN'
        : 'WORKSPACE_MEMBER';
      if (roleHierarchy.indexOf(role) > roleHierarchy.indexOf(inviterMaxRole)) throw new Error('Không thể gán role cao hơn quyền của bạn!');
    }

    // Check if user is currently an active member
    const existingActive = activeMembers.find(m => m.userId === targetUserId);
    if (existingActive) throw new Error('Người dùng đã là thành viên!');

    // Check if user previously left (soft-delete record exists)
    const previousRecord = workspace.members.find(m => m.userId === targetUserId && m.leftAt !== null);

    let member;
    if (previousRecord) {
      // Re-join: restore the record by clearing leftAt and updating role
      member = await prisma.workspaceMember.update({
        where: { id: previousRecord.id },
        data: { role, leftAt: null, invitedBy: inviterId ?? previousRecord.invitedBy },
      });
      logger.info({ workspaceId, userId: targetUserId }, 'Member re-joined workspace (leftAt cleared)');
    } else {
      member = await prisma.workspaceMember.create({
        data: { workspaceId, userId: targetUserId, role, invitedBy: inviterId },
      });
    }

    await this.autoJoinDefaultChannels(workspaceId, targetUserId);

    // Only notify active members + the new member
    const allMemberIds = activeMembers.map(m => m.userId);
    if (!allMemberIds.includes(targetUserId)) allMemberIds.push(targetUserId);

    await publishEvent(EventSubjects.WORKSPACE_MEMBER_ADDED, {
      workspaceId,
      userId: targetUserId,
      role,
      invitedBy: inviterId,
      memberIds: allMemberIds,
    });
    logger.info({ workspaceId, userId: targetUserId }, 'Member added to workspace');
    return member;
  }

  async removeMember(workspaceId: string, targetUserId: string, removerId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    // Only consider ACTIVE members for permission checks
    const activeMembers = workspace.members.filter(m => m.leftAt === null);
    const remover = activeMembers.find(m => m.userId === removerId);
    const target = activeMembers.find(m => m.userId === targetUserId);
    if (!target) throw new Error('Người dùng không phải thành viên!');

    if (targetUserId === removerId) {
      if (target.role === 'WORKSPACE_OWNER') throw new Error('Owner không thể rời workspace! Vui lòng chuyển quyền trước.');
    } else {
      const { globalRole, assignedWorkspaceIds, assignedDepartmentIds } = await userorgClient.getUserRolesAndScopes(removerId);
      const isSystemAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(globalRole);
      const isSystemWorkspaceManager = globalRole === 'WORKSPACE_MANAGER';
      const isAssigned = assignedWorkspaceIds.includes(workspace.id) || 
                         (workspace.departmentId && assignedDepartmentIds.includes(workspace.departmentId));

      const hasManagerAccess = (remover && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(remover.role)) ||
                               isSystemAdmin ||
                               (isSystemWorkspaceManager && (remover !== undefined || isAssigned)) ||
                               isAssigned ||
                               await userorgClient.checkWorkspaceAccess(removerId, workspace.id, workspace.departmentId, workspace.createdAt.toISOString());
      if (!hasManagerAccess) throw new Error('Bạn không có quyền xóa thành viên!');

      const roleHierarchy = ['WORKSPACE_GUEST', 'WORKSPACE_MEMBER', 'WORKSPACE_ADMIN', 'WORKSPACE_OWNER'];
      const removerMaxRole = (remover && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(remover.role)) || hasManagerAccess
        ? 'WORKSPACE_ADMIN'
        : 'WORKSPACE_MEMBER';
      if (roleHierarchy.indexOf(target.role) >= roleHierarchy.indexOf(removerMaxRole))
        throw new Error('Không thể xóa thành viên có quyền cao hơn hoặc bằng!');
    }

    // Notify remaining active members (excluding the leaving user)
    const allMemberIds = activeMembers
      .filter(m => m.userId !== targetUserId)
      .map(m => m.userId);

    // Soft-delete (consistent with leaveWorkspace/kickMember) + remove channel memberships
    await Promise.all([
      prisma.workspaceMember.update({
        where: { id: target.id },
        data: { leftAt: new Date(), leftReason: targetUserId === removerId ? 'SELF_LEFT' : 'KICKED' },
      }),
      prisma.channelMember.deleteMany({ where: { userId: targetUserId, channel: { workspaceId } } }),
      this.cleanupWorkspaceChatsForUser(workspaceId, targetUserId),
    ]);

    await publishEvent(EventSubjects.WORKSPACE_MEMBER_REMOVED, {
      workspaceId,
      userId: targetUserId,
      removedBy: removerId,
      isSelfLeave: targetUserId === removerId,
      memberIds: allMemberIds,
    });
    logger.info({ workspaceId, userId: targetUserId }, 'Member removed from workspace (soft-deleted)');
    return { success: true, removed: true };
  }

  async removeMemberSystem(workspaceId: string, targetUserId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const activeMembers = workspace.members.filter(m => m.leftAt === null);
    const target = activeMembers.find(m => m.userId === targetUserId);
    if (!target) return { success: false, message: 'Người dùng không phải thành viên!' };

    // Skip workspace owner to prevent orphan workspace issues
    if (target.role === 'WORKSPACE_OWNER') {
      logger.info({ workspaceId, targetUserId }, 'Skipping auto-remove of workspace owner from workspace');
      return { success: false, message: 'Skipped workspace owner' };
    }

    const allMemberIds = activeMembers
      .filter(m => m.userId !== targetUserId)
      .map(m => m.userId);

    await Promise.all([
      prisma.workspaceMember.update({
        where: { id: target.id },
        data: { leftAt: new Date(), leftReason: 'KICKED' },
      }),
      prisma.channelMember.deleteMany({ where: { userId: targetUserId, channel: { workspaceId } } }),
      this.cleanupWorkspaceChatsForUser(workspaceId, targetUserId),
    ]);

    await publishEvent(EventSubjects.WORKSPACE_MEMBER_REMOVED, {
      workspaceId,
      userId: targetUserId,
      removedBy: 'SYSTEM',
      isSelfLeave: false,
      memberIds: allMemberIds,
    });
    logger.info({ workspaceId, userId: targetUserId }, 'Member removed from workspace by SYSTEM (soft-deleted)');
    return { success: true, removed: true };
  }

  async updateMemberRole(workspaceId: string, targetUserId: string, newRole: WorkspaceRole, updaterId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const { globalRole, assignedWorkspaceIds, assignedDepartmentIds } = await userorgClient.getUserRolesAndScopes(updaterId);
    const isSystemAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(globalRole);
    const isSystemWorkspaceManager = globalRole === 'WORKSPACE_MANAGER';
    const isAssigned = assignedWorkspaceIds.includes(workspace.id) || 
                       (workspace.departmentId && assignedDepartmentIds.includes(workspace.departmentId));

    const updater = workspace.members.find(m => m.userId === updaterId && m.leftAt === null);
    const target = workspace.members.find(m => m.userId === targetUserId && m.leftAt === null);
    if (!target) throw new Error('Người dùng không phải thành viên!');

    const hasManagerAccess = (updater && ['WORKSPACE_OWNER', 'WORKSPACE_ADMIN'].includes(updater.role)) ||
                             isSystemAdmin ||
                             (isSystemWorkspaceManager && (updater !== undefined || isAssigned)) ||
                             isAssigned ||
                             await userorgClient.checkWorkspaceAccess(updaterId, workspace.id, workspace.departmentId, workspace.createdAt.toISOString());
    if (!hasManagerAccess && !updater) throw new Error('Bạn không có quyền!');

    let updaterRole: WorkspaceRole = updater?.role || 'WORKSPACE_MEMBER';
    if (hasManagerAccess && updaterRole !== 'WORKSPACE_OWNER') {
      updaterRole = 'WORKSPACE_ADMIN';
    }

    if (updaterRole !== 'WORKSPACE_OWNER' && updaterRole !== 'WORKSPACE_ADMIN') {
      throw new Error('Bạn không có quyền thay đổi role thành viên!');
    }

    const roleHierarchy = ['WORKSPACE_GUEST', 'WORKSPACE_MEMBER', 'WORKSPACE_ADMIN', 'WORKSPACE_OWNER'];
    if (roleHierarchy.indexOf(newRole) >= roleHierarchy.indexOf(updaterRole))
      throw new Error('Không thể gán role cao hơn hoặc bằng quyền của bạn!');
    if (roleHierarchy.indexOf(target.role) >= roleHierarchy.indexOf(updaterRole))
      throw new Error('Không thể thay đổi role của người có quyền cao hơn hoặc bằng!');

    if (newRole === 'WORKSPACE_OWNER') {
      if (updaterRole !== 'WORKSPACE_OWNER') throw new Error('Chỉ Owner mới có thể chuyển quyền ownership!');
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

  async getMembers(workspaceId: string, options: PaginationOptions = {}, requesterId?: string) {
    const { page = 1, limit = 50 } = options;
    const skip = (page - 1) * limit;

    const [members, total] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId, leftAt: null }, skip, take: limit,
        orderBy: [{ role: 'desc' }, { joinedAt: 'asc' }],
      }),
      prisma.workspaceMember.count({ where: { workspaceId, leftAt: null } }),
    ]);

    const userIds = members.map(m => m.userId);
    
    // Inject requesterId if not in userIds but has dynamic access
    let shouldInjectRequester = false;
    let requesterAccessRole: string | null = null;
    
    if (requesterId && !userIds.includes(requesterId)) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, departmentId: true, createdAt: true }
      });
      
      if (workspace) {
        const hasAccess = await userorgClient.checkWorkspaceAccess(
          requesterId,
          workspace.id,
          workspace.departmentId,
          workspace.createdAt.toISOString()
        );
        if (hasAccess) {
          shouldInjectRequester = true;
          requesterAccessRole = 'WORKSPACE_ADMIN';
          userIds.push(requesterId);
        }
      }
    }

    const userMap = await userorgClient.getUsers(userIds);

    const items = members.map(member => {
      let role = member.role;
      const userProfile = userMap.get(member.userId);
      const globalUserRole = userProfile?.role;
      
      if (globalUserRole) {
        const isSystemAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(globalUserRole);
        const isSystemWorkspaceManager = globalUserRole === 'WORKSPACE_MANAGER';
        if ((isSystemAdmin || isSystemWorkspaceManager) && role !== 'WORKSPACE_OWNER') {
          role = 'WORKSPACE_ADMIN';
        }
      }

      // If this is the requester, and they are a dynamic manager, upgrade their role
      if (member.userId === requesterId && requesterAccessRole) {
        role = requesterAccessRole as any;
      }
      return {
        ...member,
        role,
        user: userProfile || { name: 'Người dùng hệ thống', avatar: null, email: null }
      };
    });

    if (shouldInjectRequester && requesterId && requesterAccessRole) {
      items.push({
        id: `virtual_${requesterId}`,
        workspaceId,
        userId: requesterId,
        role: requesterAccessRole as any,
        joinedAt: new Date(),
        invitedBy: 'SYSTEM',
        leftAt: null,
        leftReason: null,
        user: userMap.get(requesterId) || { name: 'Quản trị viên hệ thống', avatar: null, email: null }
      });
    }

    return { items, total: total + (shouldInjectRequester ? 1 : 0), page, limit, totalPages: Math.ceil((total + (shouldInjectRequester ? 1 : 0)) / limit) };
  }

  async dissolveWorkspace(id: string, userId: string, workspaceNameConfirm: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');
    
    if (workspace.name !== workspaceNameConfirm) {
      throw new Error('Xác nhận tên Workspace không chính xác!');
    }

    const { globalRole } = await userorgClient.getUserRolesAndScopes(userId);
    const isSystemAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(globalRole);

    const member = workspace.members.find(m => m.userId === userId);
    if (!isSystemAdmin && (!member || member.role !== 'WORKSPACE_OWNER')) {
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

  async getWorkspaceStats(workspaceId: string, userId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: true },
    });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const isMember = workspace.members.some(m => m.userId === userId && m.leftAt === null);
    if (!isMember) throw new Error('Bạn không có quyền truy cập workspace này!');

    // Count active members
    const memberCount = workspace.members.filter(m => m.leftAt === null).length;

    // Count chats in the workspace
    const chats = await prisma.chat.findMany({
      where: { workspaceId },
      select: { id: true }
    });
    const chatIds = chats.map(c => c.id);
    const chatCount = chatIds.length;

    // Count total messages
    const messageCount = await prisma.message.count({
      where: { chatId: { in: chatIds } }
    });

    // Calculate total file storage size
    const messagesWithFiles = await prisma.message.findMany({
      where: {
        chatId: { in: chatIds },
        fileName: { not: null },
        fileSize: { not: null }
      },
      select: { fileSize: true }
    });

    let totalStorageBytes = 0;
    messagesWithFiles.forEach(m => {
      if (m.fileSize) {
        const bytes = parseInt(m.fileSize, 10);
        if (!isNaN(bytes)) {
          totalStorageBytes += bytes;
        }
      }
    });

    // Format storage size to MB/GB
    let storageSizeStr = '0 Bytes';
    if (totalStorageBytes > 0) {
      if (totalStorageBytes < 1024 * 1024) {
        storageSizeStr = `${(totalStorageBytes / 1024).toFixed(1)} KB`;
      } else if (totalStorageBytes < 1024 * 1024 * 1024) {
        storageSizeStr = `${(totalStorageBytes / (1024 * 1024)).toFixed(1)} MB`;
      } else {
        storageSizeStr = `${(totalStorageBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
      }
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const messageActivityRaw = await prisma.message.findMany({
      where: {
        chatId: { in: chatIds },
        time: { gte: thirtyDaysAgo }
      },
      select: { time: true },
    });

    const activityMap = new Map<string, number>();
    messageActivityRaw.forEach(m => {
      const date = new Date(m.time).toISOString().split('T')[0];
      activityMap.set(date, (activityMap.get(date) || 0) + 1);
    });

    const messageActivity = Array.from(activityMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const twelveWeeksAgo = new Date();
    twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 12 * 7);

    const membersActivityRaw = await prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        joinedAt: { gte: twelveWeeksAgo }
      },
      select: { joinedAt: true },
    });

    const weekMap = new Map<string, number>();
    membersActivityRaw.forEach(m => {
      const d = new Date(m.joinedAt);
      d.setHours(0,0,0,0);
      d.setDate(d.getDate() - d.getDay() + 1); // Monday
      const weekStr = d.toISOString().split('T')[0];
      weekMap.set(weekStr, (weekMap.get(weekStr) || 0) + 1);
    });

    const memberActivity = Array.from(weekMap.entries())
      .map(([week, count]) => ({ week, count }))
      .sort((a, b) => a.week.localeCompare(b.week));

    const recentMembers = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { joinedAt: 'desc' },
      take: 5,
      select: { userId: true, role: true, joinedAt: true }
    });
    
    const userIds = recentMembers.map(m => m.userId);
    const userMap = await userorgClient.getUsers(userIds);
    
    const recentActivity = recentMembers.map(m => {
      const u = userMap.get(m.userId);
      return {
        id: m.userId,
        user: u?.name || 'Người dùng',
        action: 'đã gia nhập Workspace',
        target: '',
        time: new Date(m.joinedAt).toISOString()
      };
    });

    return {
      success: true,
      memberCount,
      chatCount,
      messageCount,
      storageSize: storageSizeStr,
      messageActivity,
      memberActivity,
      recentActivity
    };
  }

  async getWorkspaceMetadata(id: string) {
    return prisma.workspace.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, ownerId: true, dissolvedAt: true, retentionDays: true, slug: true },
    });
  }

  async getWorkspaceMembers(workspaceId: string) {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId, leftAt: null },
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
        members: { some: { userId: user1Id, leftAt: null } },
        AND: {
          members: { some: { userId: user2Id, leftAt: null } }
        }
      }
    });
    return { hasSharedActiveWorkspace: sharedCount > 0, sharedCount };
  }

  private async cleanupWorkspaceChatsForUser(workspaceId: string, userId: string) {
    try {
      // 1. Find all private DMs in the workspace that this user is a participant of
      const privateDms = await prisma.chat.findMany({
        where: {
          workspaceId,
          isGroup: false,
          participants: { some: { accountId: userId } }
        },
        select: { id: true }
      });

      if (privateDms.length > 0) {
        const dmIds = privateDms.map(d => d.id);
        // Soft-delete: Hide DM for all participants of these direct messages
        await prisma.chatParticipant.updateMany({
          where: { chatId: { in: dmIds } },
          data: { hidden: true }
        });
      }

      // 2. Hard-delete the user from all channels/group chats in the workspace (isGroup: true)
      await prisma.chatParticipant.deleteMany({
        where: {
          accountId: userId,
          chat: { workspaceId, isGroup: true }
        }
      });
    } catch (err: any) {
      logger.error({ err: err.message, workspaceId, userId }, 'Failed to cleanup workspace chats for user');
    }
  }

  async deleteWorkspace(id: string, userId: string) {
    const workspace = await prisma.workspace.findUnique({ where: { id }, include: { members: true } });
    if (!workspace) throw new Error('Không tìm thấy workspace!');

    const { globalRole } = await userorgClient.getUserRolesAndScopes(userId);
    const isSystemAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(globalRole);

    const member = workspace.members.find(m => m.userId === userId);
    if (!isSystemAdmin && (!member || member.role !== 'WORKSPACE_OWNER')) {
      throw new Error('Chỉ Owner mới có quyền xóa Workspace!');
    }

    await prisma.$transaction(async (tx) => {
      // 1. Delete all chats/messages referencing this workspace
      const chats = await tx.chat.findMany({ where: { workspaceId: id } });
      const chatIds = chats.map(c => c.id);

      if (chatIds.length > 0) {
        await tx.message.deleteMany({ where: { chatId: { in: chatIds } } });
        await tx.chat.deleteMany({ where: { workspaceId: id } });
      }

      // 2. Delete channels
      await tx.channel.deleteMany({ where: { workspaceId: id } });

      // 3. Delete invites
      await tx.workspaceInvite.deleteMany({ where: { workspaceId: id } });

      // 4. Delete members
      await tx.workspaceMember.deleteMany({ where: { workspaceId: id } });

      // 5. Delete workspace itself
      await tx.workspace.delete({ where: { id } });
    });

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

    // Remove from all channels in the workspace (same as kick/remove)
    await prisma.channelMember.deleteMany({
      where: { userId, channel: { workspaceId } }
    });

    // Mirror cleanup all chats/channels in the workspace (soft-delete DMs, hard-delete group/channels)
    await this.cleanupWorkspaceChatsForUser(workspaceId, userId);

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

    // Remove kicked user from all channels in the workspace
    await prisma.channelMember.deleteMany({
      where: { userId: targetUserId, channel: { workspaceId } }
    });

    // Mirror cleanup all chats/channels in the workspace (soft-delete DMs, hard-delete group/channels)
    await this.cleanupWorkspaceChatsForUser(workspaceId, targetUserId);

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

    if (!invite) throw new Error('Không tìm thấy lời mời!');
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

        await tx.chatParticipant.createMany({
          data: defaultChannels.map(ch => ({ chatId: ch.id, accountId: userId, role: 'CHANNEL_MEMBER' as const })),
          skipDuplicates: true,
        }).catch((e: any) => logger.error({ err: e.message }, 'Failed to mirror default channels participants in acceptInvite'));
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

    await prisma.chatParticipant.createMany({
      data: defaultChannels.map(ch => ({ chatId: ch.id, accountId: userId, role: 'CHANNEL_MEMBER' as const })),
      skipDuplicates: true,
    }).catch((e: any) => logger.error({ err: e.message }, 'Failed to mirror default channels participants in autoJoinDefaultChannels'));

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
