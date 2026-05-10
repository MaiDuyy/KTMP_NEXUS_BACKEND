// services/identity-service/src/services/role.service.ts
// Migrated from rbac-service — prisma → rbacPrisma

import { rbacPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent } from '../lib/nats.js';

const RBACEventSubjects = {
  ROLE_CREATED: 'rbac.role.created',
  ROLE_UPDATED: 'rbac.role.updated',
  ROLE_DELETED: 'rbac.role.deleted',
  PERMISSION_GRANTED: 'rbac.permission.granted',
  PERMISSION_REVOKED: 'rbac.permission.revoked',
} as const;

export class RoleService {
  async getAllRoles(options?: {
    includeInactive?: boolean;
    includePermissions?: boolean;
  }) {
    const { includeInactive = false, includePermissions = false } = options || {};
    
    return rbacPrisma.role.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: includePermissions ? {
        permissions: {
          include: { permission: true }
        }
      } : undefined,
      orderBy: { level: 'asc' },
    });
  }

  async getRoleById(id: string, includePermissions = false) {
    return rbacPrisma.role.findUnique({
      where: { id },
      include: includePermissions ? {
        permissions: {
          include: { permission: true }
        }
      } : undefined,
    });
  }

  async getRoleByName(name: string) {
    return rbacPrisma.role.findUnique({
      where: { name },
    });
  }

  async createRole(data: {
    name: string;
    displayName: string;
    description?: string;
    level: number;
    isSystem?: boolean;
  }) {
    const role = await rbacPrisma.role.create({
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

  async updateRole(id: string, data: Partial<{
    displayName: string;
    description: string;
    level: number;
    isActive: boolean;
  }>) {
    const existingRole = await rbacPrisma.role.findUnique({ where: { id } });
    
    if (!existingRole) {
      throw new Error('Role not found');
    }
    
    if (existingRole.isSystem && data.level !== undefined) {
      throw new Error('Cannot change level of system roles');
    }

    const role = await rbacPrisma.role.update({
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

  async deleteRole(id: string): Promise<void> {
    const role = await rbacPrisma.role.findUnique({ where: { id } });
    
    if (!role) {
      throw new Error('Role not found');
    }
    
    if (role.isSystem) {
      throw new Error('Cannot delete system roles');
    }

    await rbacPrisma.role.update({
      where: { id },
      data: { isActive: false },
    });

    await publishEvent(RBACEventSubjects.ROLE_DELETED, { roleId: id });
    logger.info({ roleId: id }, 'Role deleted (deactivated)');
  }

  async assignPermissionsToRole(roleId: string, permissionIds: string[]): Promise<void> {
    await rbacPrisma.rolePermission.createMany({
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

  async removePermissionsFromRole(roleId: string, permissionIds: string[]): Promise<void> {
    await rbacPrisma.rolePermission.deleteMany({
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

  async canAssignRole(assignerRoleLevel: number, targetRoleName: string): Promise<boolean> {
    const targetRole = await this.getRoleByName(targetRoleName);
    if (!targetRole) return false;
    return assignerRoleLevel < targetRole.level;
  }
}

export const roleService = new RoleService();
