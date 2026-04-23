import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { Permission } from '@prisma/client';

export class PermissionService {
  // Get all permissions
  async getAllPermissions(): Promise<Permission[]> {
    return prisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  // Get permissions by resource
  async getPermissionsByResource(resource: string): Promise<Permission[]> {
    return prisma.permission.findMany({
      where: { resource },
      orderBy: { action: 'asc' },
    });
  }

  // Get permission by ID
  async getPermissionById(id: string): Promise<Permission | null> {
    return prisma.permission.findUnique({ where: { id } });
  }

  // Get or create permission
  async getOrCreatePermission(data: {
    resource: string;
    action: string;
    scope?: string;
    description?: string;
  }): Promise<Permission> {
    const existing = await prisma.permission.findUnique({
      where: {
        resource_action_scope: {
          resource: data.resource,
          action: data.action,
          scope: data.scope || 'own',
        },
      },
    });

    if (existing) return existing;

    return prisma.permission.create({
      data: {
        resource: data.resource,
        action: data.action,
        scope: data.scope || 'own',
        description: data.description,
      },
    });
  }

  // Create multiple permissions
  async createPermissions(permissions: Array<{
    resource: string;
    action: string;
    scope?: string;
    description?: string;
  }>): Promise<number> {
    const result = await prisma.permission.createMany({
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

  // Check if a role has a specific permission
  async roleHasPermission(
    roleId: string,
    resource: string,
    action: string,
    scope?: string
  ): Promise<boolean> {
    const permission = await prisma.rolePermission.findFirst({
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

  // Get all permissions for a role
  async getRolePermissions(roleId: string): Promise<Permission[]> {
    const rolePermissions = await prisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true },
    });

    return rolePermissions.map(rp => rp.permission);
  }
}

export const permissionService = new PermissionService();
