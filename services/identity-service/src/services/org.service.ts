// services/identity-service/src/services/org.service.ts
// Migrated from rbac-service — prisma → rbacPrisma

import { rbacPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

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
    return rbacPrisma.department.findUnique({
      where: { id },
      include: {
        parent: true,
        children: true,
        members: true,
      },
    });
  }

  async createDepartment(data: {
    name: string;
    description?: string;
    parentId?: string;
    managerId?: string;
  }) {
    const department = await rbacPrisma.department.create({ data });
    logger.info({ departmentId: department.id, name: department.name }, 'Department created');
    return department;
  }

  async updateDepartment(id: string, data: Partial<{
    name: string;
    description: string;
    parentId: string;
    managerId: string;
  }>) {
    const department = await rbacPrisma.department.update({ where: { id }, data });
    logger.info({ departmentId: id }, 'Department updated');
    return department;
  }

  async deleteDepartment(id: string): Promise<void> {
    await rbacPrisma.department.delete({ where: { id } });
    logger.info({ departmentId: id }, 'Department deleted');
  }

  async addMember(departmentId: string, userId: string, isPrimary = false) {
    if (isPrimary) {
      await rbacPrisma.departmentMember.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const member = await rbacPrisma.departmentMember.upsert({
      where: {
        userId_departmentId: { userId, departmentId },
      },
      update: { isPrimary },
      create: { userId, departmentId, isPrimary },
    });

    logger.info({ departmentId, userId }, 'Member added to department');
    return member;
  }

  async removeMember(departmentId: string, userId: string): Promise<void> {
    await rbacPrisma.departmentMember.delete({
      where: {
        userId_departmentId: { userId, departmentId },
      },
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
