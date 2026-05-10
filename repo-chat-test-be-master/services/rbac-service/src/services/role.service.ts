import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent, RBACEventSubjects } from '../lib/nats.js';
import type { Role, Prisma } from '@prisma/client';

export class RoleService {
  // Get all roles
  async getAllRoles(options?: {
    includeInactive?: boolean;
    includePermissions?: boolean;
  }): Promise<Role[]> {
    const { includeInactive = false, includePermissions = false } = options || {};
    
    return prisma.role.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: includePermissions ? {
        permissions: {
          include: { permission: true }
        }
      } : undefined,
      orderBy: { level: 'asc' },
    });
  }

  // Get role by ID
  async getRoleById(id: string, includePermissions = false): Promise<Role | null> {
    return prisma.role.findUnique({
      where: { id },
      include: includePermissions ? {
        permissions: {
          include: { permission: true }
        }
      } : undefined,
    });
  }

  // Get role by name
  async getRoleByName(name: string): Promise<Role | null> {
    return prisma.role.findUnique({
      where: { name },
    });
  }

  // Create a new role
  async createRole(data: {
    name: string;
    displayName: string;
    description?: string;
    level: number;
    isSystem?: boolean;
  }): Promise<Role> {
    const role = await prisma.role.create({
      data: {
        name: data.name.toUpperCase(),
        displayName: data.displayName,
        description: data.description,
        level: data.level,
        isSystem: data.isSystem ?? false,
      },
    });

    await publishEvent(RBACEventSubjects.ROLE_CREATED, {
      roleId: role.id,
      name: role.name,
      level: role.level,
    });

    logger.info({ roleId: role.id, name: role.name }, 'Role created');
    return role;
  }

  // Update a role
  async updateRole(id: string, data: Partial<{
    displayName: string;
    description: string;
    level: number;
    isActive: boolean;
  }>): Promise<Role> {
    const existingRole = await prisma.role.findUnique({ where: { id } });
    
    if (!existingRole) {
      throw new Error('Role not found');
    }
    
    if (existingRole.isSystem && data.level !== undefined) {
      throw new Error('Cannot change level of system roles');
    }

    const role = await prisma.role.update({
      where: { id },
      data,
    });

    await publishEvent(RBACEventSubjects.ROLE_UPDATED, {
      roleId: role.id,
      changes: data,
    });

    logger.info({ roleId: role.id }, 'Role updated');
    return role;
  }

  // Delete a role (soft delete by deactivating)
  async deleteRole(id: string): Promise<void> {
    const role = await prisma.role.findUnique({ where: { id } });
    
    if (!role) {
      throw new Error('Role not found');
    }
    
    if (role.isSystem) {
      throw new Error('Cannot delete system roles');
    }

    await prisma.role.update({
      where: { id },
      data: { isActive: false },
    });

    await publishEvent(RBACEventSubjects.ROLE_DELETED, { roleId: id });
    logger.info({ roleId: id }, 'Role deleted (deactivated)');
  }

  // Assign permissions to a role
  async assignPermissionsToRole(roleId: string, permissionIds: string[]): Promise<void> {
    await prisma.rolePermission.createMany({
      data: permissionIds.map(permissionId => ({
        roleId,
        permissionId,
      })),
      skipDuplicates: true,
    });

    await publishEvent(RBACEventSubjects.PERMISSION_GRANTED, {
      roleId,
      permissionIds,
    });
    
    logger.info({ roleId, count: permissionIds.length }, 'Permissions assigned to role');
  }

  // Remove permissions from a role
  async removePermissionsFromRole(roleId: string, permissionIds: string[]): Promise<void> {
    await prisma.rolePermission.deleteMany({
      where: {
        roleId,
        permissionId: { in: permissionIds },
      },
    });

    await publishEvent(RBACEventSubjects.PERMISSION_REVOKED, {
      roleId,
      permissionIds,
    });
    
    logger.info({ roleId, count: permissionIds.length }, 'Permissions removed from role');
  }

  // Get role hierarchy (for checking if user can assign role)
  async canAssignRole(assignerRoleLevel: number, targetRoleName: string): Promise<boolean> {
    const targetRole = await this.getRoleByName(targetRoleName);
    if (!targetRole) return false;
    
    // Can only assign roles with higher level numbers (lower privilege)
    return assignerRoleLevel < targetRole.level;
  }
}

export const roleService = new RoleService();
