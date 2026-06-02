// services/identity-service/src/services/org.service.ts
// Migrated from rbac-service — prisma → rbacPrisma

import { rbacPrisma, userorgPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import crypto from 'crypto';

// ==================== DEPARTMENT SERVICE ====================

export class DepartmentService {
  async getAllDepartments() {
    return rbacPrisma.department.findMany({
      include: {
        parent: true,
        children: true,
        _count: { select: { members: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getDepartmentById(id: string) {
    const dept = await rbacPrisma.department.findUnique({
      where: { id },
      include: {
        parent: true,
        children: true,
        members: true,
      },
    });

    if (!dept) return null;

    // Fetch user details for each member from userorg DB
    const userIds = dept.members.map(m => m.userId);
    const accounts = await userorgPrisma.account.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
      },
    });

    const accountsMap = new Map(accounts.map(acc => [acc.id, acc]));

    // Map members with their user info
    const membersWithUser = dept.members.map(m => ({
      ...m,
      user: accountsMap.get(m.userId) ? {
        id: accountsMap.get(m.userId)!.id,
        name: accountsMap.get(m.userId)!.name,
        email: accountsMap.get(m.userId)!.email,
        avatar: accountsMap.get(m.userId)!.avatar || undefined,
      } : undefined
    }));

    return {
      ...dept,
      members: membersWithUser,
    };
  }

  async createDepartment(data: {
    name: string;
    description?: string | null;
    parentId?: string | null;
    managerId?: string | null;
  }) {
    const department = await rbacPrisma.department.create({ data });
    logger.info({ departmentId: department.id, name: department.name }, 'Department created');

    if (data.managerId) {
      await rbacPrisma.departmentMember.upsert({
        where: { userId_departmentId: { userId: data.managerId, departmentId: department.id } },
        update: { role: 'HEAD', isPrimary: true },
        create: { userId: data.managerId, departmentId: department.id, role: 'HEAD', isPrimary: true }
      }).catch(err => logger.error({ err }, 'Failed to create Dept Head member'));
    }

    return department;
  }

  async updateDepartment(id: string, data: Partial<{
    name: string;
    description: string | null;
    parentId: string | null;
    managerId: string | null;
  }>) {
    const oldDept = await rbacPrisma.department.findUnique({ where: { id } });
    const oldManagerId = oldDept?.managerId;

    const department = await rbacPrisma.department.update({ where: { id }, data });
    logger.info({ departmentId: id }, 'Department updated');

    if ('managerId' in data && data.managerId !== oldManagerId) {
      if (oldManagerId) {
        await rbacPrisma.departmentMember.updateMany({
          where: { departmentId: id, userId: oldManagerId, role: 'HEAD' },
          data: { role: 'MEMBER' }
        }).catch(() => {});
      }

      if (data.managerId) {
        await rbacPrisma.departmentMember.upsert({
          where: { userId_departmentId: { userId: data.managerId, departmentId: id } },
          update: { role: 'HEAD', isPrimary: true },
          create: { userId: data.managerId, departmentId: id, role: 'HEAD', isPrimary: true }
        }).catch(err => logger.error({ err }, 'Failed to upsert new Dept Head member'));
      }

      await publishEvent('department.manager_transferred', {
        departmentId: id,
        oldManagerId: oldManagerId || null,
        newManagerId: data.managerId || null
      }).catch(err => logger.warn({ err: err.message }, 'Failed to publish department.manager_transferred'));
    }

    return department;
  }

  async deleteDepartment(id: string): Promise<void> {
    await rbacPrisma.department.delete({ where: { id } });
    logger.info({ departmentId: id }, 'Department deleted');
  }

  async addMember(departmentId: string, userId: string, role = 'MEMBER', isPrimary = false, actorId?: string) {
    // 1. Strict single-primary-department check for formal roles (HEAD, MANAGER, MEMBER)
    if (['HEAD', 'MANAGER', 'MEMBER'].includes(role)) {
      const existingDeptMember = await rbacPrisma.departmentMember.findFirst({
        where: {
          userId,
          role: { in: ['HEAD', 'MANAGER', 'MEMBER'] },
          departmentId: { not: departmentId }
        },
        include: { department: true }
      });

      if (existingDeptMember) {
        if (role === 'HEAD') {
          // Manual intervention guard for Dept Head
          throw new Error(`Nhân sự này đang thuộc phòng ban "${existingDeptMember.department.name}". Vui lòng bàn giao công việc và gỡ nhân sự khỏi phòng ban cũ trước khi bổ nhiệm mới.`);
        } else {
          throw new Error(`Nhân sự này đã là thành viên chính thức của phòng ban "${existingDeptMember.department.name}"!`);
        }
      }
    }

    // 2. Fetch old member role for audit logging
    const oldMember = await rbacPrisma.departmentMember.findUnique({
      where: { userId_departmentId: { userId, departmentId } }
    });
    const oldRole = oldMember ? oldMember.role : null;

    if (isPrimary) {
      await rbacPrisma.departmentMember.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    // Sync department managerId if role is HEAD
    let oldManagerId: string | null = null;
    if (role === 'HEAD') {
      const dept = await rbacPrisma.department.findUnique({ where: { id: departmentId } });
      oldManagerId = dept?.managerId || null;
      if (oldManagerId && oldManagerId !== userId) {
        // Demote old manager member role to MEMBER
        await rbacPrisma.departmentMember.updateMany({
          where: { departmentId, userId: oldManagerId, role: 'HEAD' },
          data: { role: 'MEMBER' }
        }).catch(() => {});

        // Log audit log for old manager demotion
        try {
          const { auditLogService } = await import('./audit.service.js');
          await auditLogService.createLog({
            userId: actorId || userId,
            action: 'REMOVE_HEAD',
            resource: 'department',
            data: { departmentId, targetUserId: oldManagerId, oldRole: 'HEAD', newRole: 'MEMBER', isDemotion: true },
            status: 'SUCCESS',
          });
        } catch (err) {}
      }
      // Update department managerId
      await rbacPrisma.department.update({
        where: { id: departmentId },
        data: { managerId: userId }
      });
    } else {
      // If role is NOT HEAD, but this user was the department manager, clear the managerId
      const dept = await rbacPrisma.department.findUnique({ where: { id: departmentId } });
      if (dept?.managerId === userId) {
        await rbacPrisma.department.update({
          where: { id: departmentId },
          data: { managerId: null }
        });
      }
    }

    const member = await rbacPrisma.departmentMember.upsert({
      where: {
        userId_departmentId: { userId, departmentId },
      },
      update: { isPrimary, role },
      create: { userId, departmentId, isPrimary, role },
    });

    // Write rich Audit Log
    try {
      const { auditLogService } = await import('./audit.service.js');
      const auditAction = role === 'HEAD' ? 'ASSIGN_HEAD' : oldRole ? 'CHANGE_ROLE' : 'ADD_MEMBER';
      await auditLogService.createLog({
        userId: actorId || userId,
        action: auditAction,
        resource: 'department',
        data: { departmentId, targetUserId: userId, oldRole, newRole: role },
        status: 'SUCCESS',
      });
    } catch (err) {}

    await publishEvent(EventSubjects.DEPARTMENT_MEMBER_ADDED, {
      departmentId,
      userId,
      role,
    });

    logger.info({ departmentId, userId, role }, 'Member added/updated in department');
    return member;
  }

  async removeMember(departmentId: string, userId: string, actorId?: string): Promise<void> {
    const member = await rbacPrisma.departmentMember.findUnique({
      where: { userId_departmentId: { userId, departmentId } }
    });
    const oldRole = member ? member.role : null;

    const dept = await rbacPrisma.department.findUnique({ where: { id: departmentId } });
    if (dept?.managerId === userId) {
      await rbacPrisma.department.update({
        where: { id: departmentId },
        data: { managerId: null }
      });
    }

    await rbacPrisma.departmentMember.delete({
      where: {
        userId_departmentId: { userId, departmentId },
      },
    });

    try {
      const { auditLogService } = await import('./audit.service.js');
      await auditLogService.createLog({
        userId: actorId || userId,
        action: 'REMOVE_MEMBER',
        resource: 'department',
        data: { departmentId, targetUserId: userId, oldRole },
        status: 'SUCCESS',
      });
    } catch (err) {}

    await publishEvent(EventSubjects.DEPARTMENT_MEMBER_REMOVED, {
      departmentId,
      userId,
    });

    logger.info({ departmentId, userId }, 'Member removed from department');
  }

  async getUserDepartments(userId: string): Promise<string[]> {
    const memberships = await rbacPrisma.departmentMember.findMany({
      where: { userId },
      orderBy: { isPrimary: 'desc' },
      select: { department: { select: { name: true } } },
    });
    return memberships.map(m => m.department.name);
  }

  async getUserDetailedDepartments(userId: string) {
    const memberships = await rbacPrisma.departmentMember.findMany({
      where: { userId },
      orderBy: { isPrimary: 'desc' },
    });

    const depts = [];
    for (const membership of memberships) {
      const deptDetails = await this.getDepartmentById(membership.departmentId);
      if (deptDetails) {
        depts.push({
          ...deptDetails,
          userRole: membership.role
        });
      }
    }
    return depts;
  }
}

// ==================== GROUP SERVICE (RBAC Groups, not chat groups) ====================

export class RbacGroupService {
  async getAllGroups() {
    return rbacPrisma.group.findMany({
      where: { isActive: true },
      include: {
        _count: { select: { members: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getGroupById(id: string) {
    return rbacPrisma.group.findUnique({
      where: { id },
      include: { members: true },
    });
  }

  async createGroup(data: {
    name: string;
    description?: string;
    ownerId: string;
  }) {
    const group = await rbacPrisma.group.create({ data });
    
    await rbacPrisma.groupMember.create({
      data: {
        groupId: group.id,
        userId: data.ownerId,
        role: 'admin',
      },
    });

    logger.info({ groupId: group.id, name: group.name }, 'Group created');
    return group;
  }

  async updateGroup(id: string, data: Partial<{
    name: string;
    description: string;
    isActive: boolean;
  }>) {
    const group = await rbacPrisma.group.update({ where: { id }, data });
    logger.info({ groupId: id }, 'Group updated');
    return group;
  }

  async deleteGroup(id: string): Promise<void> {
    await rbacPrisma.group.update({
      where: { id },
      data: { isActive: false },
    });
    logger.info({ groupId: id }, 'Group deleted (deactivated)');
  }

  async addMember(groupId: string, userId: string, role = 'member') {
    const member = await rbacPrisma.groupMember.upsert({
      where: {
        userId_groupId: { userId, groupId },
      },
      update: { role },
      create: { userId, groupId, role },
    });

    logger.info({ groupId, userId, role }, 'Member added to group');
    return member;
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    await rbacPrisma.groupMember.delete({
      where: {
        userId_groupId: { userId, groupId },
      },
    });
    logger.info({ groupId, userId }, 'Member removed from group');
  }

  async getUserGroups(userId: string): Promise<string[]> {
    const memberships = await rbacPrisma.groupMember.findMany({
      where: { userId },
      select: { group: { select: { name: true } } },
    });
    return memberships.map(m => m.group.name);
  }

  async isGroupAdmin(groupId: string, userId: string): Promise<boolean> {
    const membership = await rbacPrisma.groupMember.findUnique({
      where: {
        userId_groupId: { userId, groupId },
      },
    });
    return membership?.role === 'admin';
  }
}

export const departmentService = new DepartmentService();
export const rbacGroupService = new RbacGroupService();

export class DepartmentInvitationService {
  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  async createInvitation(data: {
    departmentId: string;
    email: string;
    role: string;
    invitedBy: string;
  }) {
    const { departmentId, email, role, invitedBy } = data;
    const emailLower = email.toLowerCase().trim();

    // Check if department exists
    const dept = await rbacPrisma.department.findUnique({
      where: { id: departmentId },
      include: { members: { select: { role: true } } }
    });
    if (!dept) throw new Error('Không tìm thấy phòng ban!');

    // Guard: HEAD role is unique per department
    if (role === 'HEAD') {
      const existingHead = dept.members.find((m: any) => m.role === 'HEAD');
      if (existingHead) {
        throw new Error('Phòng ban này đã có Trưởng phòng (HEAD). Không thể mời thêm người vào vị trí này!');
      }
    }

    // Check if email already has pending invitation for this department
    const existingInvite = await rbacPrisma.departmentInvitation.findFirst({
      where: {
        departmentId,
        invitedEmail: emailLower,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
    });
    if (existingInvite) throw new Error('Email này đã có lời mời tham gia phòng ban đang chờ xử lý!');

    // Check if user already exists
    const existingUser = await userorgPrisma.account.findUnique({ where: { email: emailLower } });
    if (existingUser) {
      // Check if already a member of this department
      const existingMember = await rbacPrisma.departmentMember.findUnique({
        where: { userId_departmentId: { userId: existingUser.id, departmentId } },
      });
      if (existingMember) {
        throw new Error('Người dùng đã là thành viên của phòng ban này!');
      }
    }

    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 48); // 48 hours for Flow C

    const invitation = await rbacPrisma.departmentInvitation.create({
      data: {
        departmentId,
        invitedEmail: emailLower,
        role: role || 'MEMBER',
        token,
        status: 'PENDING',
        expiresAt,
        invitedBy,
      },
    });

    // Send invitation email
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
    const inviteUrl = `${baseUrl}/invite/department?token=${token}`;
    
    await publishEvent('invitation.send', {
      to: emailLower,
      template: 'invitation',
      data: {
        inviteUrl,
        inviterName: 'Trưởng phòng / Admin',
        orgName: dept.name,
        expiresAt: expiresAt.toISOString(),
        type: 'DEPARTMENT',
      },
    }).catch(err => logger.warn({ err: err.message }, 'Failed to publish department invitation email event'));

    return invitation;
  }

  async validateInvitation(token: string) {
    const invite = await rbacPrisma.departmentInvitation.findUnique({
      where: { token },
      include: { department: true }
    });
    if (!invite) return null;

    let status = invite.status;
    if (invite.status === 'PENDING' && new Date() > invite.expiresAt) {
      status = 'EXPIRED';
      await rbacPrisma.departmentInvitation.update({ where: { id: invite.id }, data: { status } });
    }

    // Check if email already exists in system
    const userExists = await userorgPrisma.account.findUnique({ where: { email: invite.invitedEmail } });

    return {
      ...invite,
      status,
      userExists: !!userExists,
    };
  }

  async acceptInvitation(token: string, userData: { name: string; password?: string; gender?: string }) {
    const invite = await rbacPrisma.departmentInvitation.findUnique({ where: { token } });
    if (!invite) throw new Error('Lời mời không hợp lệ!');
    
    let status = invite.status;
    if (invite.status === 'PENDING' && new Date() > invite.expiresAt) {
      status = 'EXPIRED';
      await rbacPrisma.departmentInvitation.update({ where: { id: invite.id }, data: { status } });
    }
    if (status !== 'PENDING') throw new Error(`Lời mời này đã ${status === 'ACCEPTED' ? 'được sử dụng' : 'hết hạn hoặc bị từ chối'}!`);

    const emailLower = invite.invitedEmail.toLowerCase();
    
    // Check if user exists in userorg DB
    let user = await userorgPrisma.account.findUnique({ where: { email: emailLower } });
    let loginData: any = null;

    if (user) {
      // User exists, join immediately
      await rbacPrisma.departmentInvitation.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedBy: user.id },
      });

      await departmentService.addMember(invite.departmentId, user.id, invite.role);
    } else {
      // User does not exist, create new account first
      if (!userData.name || !userData.password) {
        throw new Error('Vui lòng cung cấp đầy đủ tên và mật khẩu để tạo tài khoản!');
      }

      // Import authService dynamically to avoid circular dependency
      const { authService } = await import('./auth.service.js');
      
      loginData = await authService.createAccountFromInvitation({
        email: emailLower,
        name: userData.name,
        password: userData.password,
        gender: userData.gender || 'other',
        role: 'EMPLOYEE', // System level role
        invitedBy: invite.invitedBy,
      });

      const newUserId = loginData.user.id;

      await rbacPrisma.departmentInvitation.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedBy: newUserId },
      });

      await departmentService.addMember(invite.departmentId, newUserId, invite.role);
    }

    return {
      success: true,
      message: 'Chấp nhận lời mời phòng ban thành công!',
      loginData
    };
  }

  async rejectInvitation(token: string) {
    const invite = await rbacPrisma.departmentInvitation.findUnique({ where: { token } });
    if (!invite) throw new Error('Lời mời không hợp lệ!');
    if (invite.status !== 'PENDING') throw new Error('Lời mời này không còn ở trạng thái chờ!');

    await rbacPrisma.departmentInvitation.update({
      where: { id: invite.id },
      data: { status: 'DECLINED' }
    });

    return { success: true };
  }

  async listInvitations(departmentId: string) {
    return rbacPrisma.departmentInvitation.findMany({
      where: { departmentId },
      orderBy: { createdAt: 'desc' }
    });
  }
}

export const departmentInvitationService = new DepartmentInvitationService();
