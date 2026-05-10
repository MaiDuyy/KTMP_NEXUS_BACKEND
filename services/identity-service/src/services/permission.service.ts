// services/identity-service/src/services/permission.service.ts
// Migrated from rbac-service — prisma → rbacPrisma

import { rbacPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export class PermissionService {
  async getAllPermissions() {
    return rbacPrisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async getPermissionsByResource(resource: string) {
    return rbacPrisma.permission.findMany({
      where: { resource },
      orderBy: { action: 'asc' },
    });
  }

  async getPermissionById(id: string) {
    return rbacPrisma.permission.findUnique({ where: { id } });
  }

  async getOrCreatePermission(data: {
    resource: string;
    action: string;
    scope?: string;
    description?: string;
  }) {
    const existing = await rbacPrisma.permission.findUnique({
      where: {
        resource_action_scope: {
          resource: data.resource,
          action: data.action,
          scope: data.scope || 'own',
        },
      },
    });

    if (existing) return existing;

    return rbacPrisma.permission.create({
      data: {
        resource: data.resource,
        action: data.action,
        scope: data.scope || 'own',
        description: data.description,
      },
    });
  }

  async createPermissions(permissions: Array<{
    resource: string;
    action: string;
    scope?: string;
    description?: string;
  }>): Promise<number> {
    const result = await rbacPrisma.permission.createMany({
      data: permissions.map(p => ({
        resource: p.resource,
        action: p.action,
        scope: p.scope || 'own',
        description: p.description,
      })),
      skipDuplicates: true,
    });

    logger.info({ count: result.count }, 'Permissions created');
    return result.count;
  }

  async roleHasPermission(
    roleId: string,
    resource: string,
    action: string,
    scope?: string
  ): Promise<boolean> {
    const permission = await rbacPrisma.rolePermission.findFirst({
      where: {
        roleId,
        permission: {
          resource,
          action,
          scope: scope ? { in: [scope, 'system'] } : undefined,
        },
      },
    });

    return !!permission;
  }

  async getRolePermissions(roleId: string) {
    const rolePermissions = await rbacPrisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true },
    });

    return rolePermissions.map(rp => rp.permission);
  }
}

export const permissionService = new PermissionService();
