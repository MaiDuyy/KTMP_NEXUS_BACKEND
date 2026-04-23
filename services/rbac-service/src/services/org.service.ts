import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { Department, DepartmentMember, Group, GroupMember } from '@prisma/client';

// ==================== DEPARTMENT SERVICE ====================

export class DepartmentService {
  // Get all departments
  async getAllDepartments(): Promise<Department[]> {
    return prisma.department.findMany({
      include: {
        parent: true,
        children: true,
        _count: { select: { members: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  // Get department by ID
  async getDepartmentById(id: string): Promise<Department | null> {
    return prisma.department.findUnique({
      where: { id },
      include: {
        parent: true,
        children: true,
        members: true,
      },
    });
  }

  // Create department
  async createDepartment(data: {
    name: string;
    description?: string;
    parentId?: string;
    managerId?: string;
  }): Promise<Department> {
    const department = await prisma.department.create({ data });
    logger.info({ departmentId: department.id, name: department.name }, 'Department created');
    return department;
  }

  // Update department
  async updateDepartment(id: string, data: Partial<{
    name: string;
    description: string;
    parentId: string;
    managerId: string;
  }>): Promise<Department> {
    const department = await prisma.department.update({ where: { id }, data });
    logger.info({ departmentId: id }, 'Department updated');
    return department;
  }

  // Delete department
  async deleteDepartment(id: string): Promise<void> {
    await prisma.department.delete({ where: { id } });
    logger.info({ departmentId: id }, 'Department deleted');
  }

  // Add member to department
  async addMember(departmentId: string, userId: string, isPrimary = false): Promise<DepartmentMember> {
    // If setting as primary, remove primary from other departments
    if (isPrimary) {
      await prisma.departmentMember.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const member = await prisma.departmentMember.upsert({
      where: {
        userId_departmentId: { userId, departmentId },
      },
      update: { isPrimary },
      create: { userId, departmentId, isPrimary },
    });

    logger.info({ departmentId, userId }, 'Member added to department');
    return member;
  }

  // Remove member from department
  async removeMember(departmentId: string, userId: string): Promise<void> {
    await prisma.departmentMember.delete({
      where: {
        userId_departmentId: { userId, departmentId },
      },
    });
    logger.info({ departmentId, userId }, 'Member removed from department');
  }

  // Get user's departments
  async getUserDepartments(userId: string): Promise<string[]> {
    const memberships = await prisma.departmentMember.findMany({
      where: { userId },
      select: { department: { select: { name: true } } },
    });
    return memberships.map(m => m.department.name);
  }
}

// ==================== GROUP SERVICE ====================

export class GroupService {
  // Get all groups
  async getAllGroups(): Promise<Group[]> {
    return prisma.group.findMany({
      where: { isActive: true },
      include: {
        _count: { select: { members: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  // Get group by ID
  async getGroupById(id: string): Promise<Group | null> {
    return prisma.group.findUnique({
      where: { id },
      include: { members: true },
    });
  }

  // Create group
  async createGroup(data: {
    name: string;
    description?: string;
    ownerId: string;
  }): Promise<Group> {
    const group = await prisma.group.create({ data });
    
    // Add owner as admin member
    await prisma.groupMember.create({
      data: {
        groupId: group.id,
        userId: data.ownerId,
        role: 'admin',
      },
    });

    logger.info({ groupId: group.id, name: group.name }, 'Group created');
    return group;
  }

  // Update group
  async updateGroup(id: string, data: Partial<{
    name: string;
    description: string;
    isActive: boolean;
  }>): Promise<Group> {
    const group = await prisma.group.update({ where: { id }, data });
    logger.info({ groupId: id }, 'Group updated');
    return group;
  }

  // Delete group (soft delete)
  async deleteGroup(id: string): Promise<void> {
    await prisma.group.update({
      where: { id },
      data: { isActive: false },
    });
    logger.info({ groupId: id }, 'Group deleted (deactivated)');
  }

  // Add member to group
  async addMember(groupId: string, userId: string, role = 'member'): Promise<GroupMember> {
    const member = await prisma.groupMember.upsert({
      where: {
        userId_groupId: { userId, groupId },
      },
      update: { role },
      create: { userId, groupId, role },
    });

    logger.info({ groupId, userId, role }, 'Member added to group');
    return member;
  }

  // Remove member from group
  async removeMember(groupId: string, userId: string): Promise<void> {
    await prisma.groupMember.delete({
      where: {
        userId_groupId: { userId, groupId },
      },
    });
    logger.info({ groupId, userId }, 'Member removed from group');
  }

  // Get user's groups
  async getUserGroups(userId: string): Promise<string[]> {
    const memberships = await prisma.groupMember.findMany({
      where: { userId },
      select: { group: { select: { name: true } } },
    });
    return memberships.map(m => m.group.name);
  }

  // Check if user is group admin
  async isGroupAdmin(groupId: string, userId: string): Promise<boolean> {
    const membership = await prisma.groupMember.findUnique({
      where: {
        userId_groupId: { userId, groupId },
      },
    });
    return membership?.role === 'admin';
  }
}

export const departmentService = new DepartmentService();
export const groupService = new GroupService();
