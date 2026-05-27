// services/identity-service/src/services/user-role.service.ts
// Migrated from rbac-service — prisma → rbacPrisma

import { rbacPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent } from '../lib/nats.js';
import { permissionService } from './permission.service.js';

const RBACEventSubjects = {
  ROLE_ASSIGNED: 'rbac.role.assigned',
  ROLE_REVOKED: 'rbac.role.revoked',
} as const;

export interface UserPermissions {
  userId: string;
  roles: string[];
  roleLevel: number;
  departments: string[];
  groups: string[];
  permissions: Array<{
    resource: string;
    action: string;
    scope: string;
  }>;
}

export class UserRoleService {
  async getUserRoles(userId: string) {
    return rbacPrisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: {
            permissions: {
              include: { permission: true }
            }
          }
        }
      },
    });
  }

  async assignRole(data: {
    userId: string;
    roleId: string;
    grantedBy: string;
    orgId?: string;
    workspaceId?: string;
    departmentId?: string;
    expiresAt?: Date;
  }) {
    const role = await rbacPrisma.role.findUnique({ where: { id: data.roleId } });
    if (!role) {
      throw new Error('Role not found');
    }

    const SYSTEM_ACCOUNT = 'SYSTEM';
    const isSelfRegistration = data.grantedBy === data.userId;
    const isSystemAssignment = data.grantedBy === SYSTEM_ACCOUNT;
    
    if (!isSelfRegistration && !isSystemAssignment) {
      const assignerRoles = await this.getUserRoles(data.grantedBy);
      const assignerLevel = Math.min(...assignerRoles.map(ur => ur.role.level), Infinity);
      
      if (assignerLevel >= role.level) {
        throw new Error('Cannot assign role with equal or higher privilege');
      }
    }

    const userRole = await rbacPrisma.userRole.create({
      data: {
        userId: data.userId,
        roleId: data.roleId,
        grantedBy: data.grantedBy,
        orgId: data.orgId,
        workspaceId: data.workspaceId,
        departmentId: data.departmentId,
        expiresAt: data.expiresAt,
      },
    });

    await publishEvent(RBACEventSubjects.ROLE_ASSIGNED, {
      userId: data.userId,
      roleId: data.roleId,
      roleName: role.name,
      grantedBy: data.grantedBy,
    });

    if (data.workspaceId) {
      await publishEvent('workspace.role.assigned', {
        userId: data.userId,
        workspaceId: data.workspaceId,
        role: role.name,
        orgId: data.orgId,
        timestamp: new Date().toISOString()
      });
    }

    logger.info({ userId: data.userId, roleId: data.roleId }, 'Role assigned to user');
    return userRole;
  }

  async revokeRole(userId: string, roleId: string, revokedBy: string): Promise<void> {
    const userRole = await rbacPrisma.userRole.findFirst({
      where: { userId, roleId },
      include: { role: true },
    });

    if (!userRole) {
      throw new Error('User does not have this role');
    }

    const revokerRoles = await this.getUserRoles(revokedBy);
    const revokerLevel = Math.min(...revokerRoles.map(ur => ur.role.level), Infinity);
    
    if (revokerLevel >= userRole.role.level) {
      throw new Error('Cannot revoke role with equal or higher privilege');
    }

    await rbacPrisma.userRole.delete({
      where: { id: userRole.id },
    });

    await publishEvent(RBACEventSubjects.ROLE_REVOKED, {
      userId,
      roleId,
      roleName: userRole.role.name,
      revokedBy,
    });

    if (userRole.workspaceId) {
      await publishEvent('workspace.role.revoked', {
        userId,
        workspaceId: userRole.workspaceId,
        role: userRole.role.name,
        orgId: userRole.orgId,
        timestamp: new Date().toISOString()
      });
    }

    logger.info({ userId, roleId }, 'Role revoked from user');
  }

  async getUserPermissions(userId: string): Promise<UserPermissions> {
    const [userRoles, departmentMemberships, groupMemberships] = await Promise.all([
      this.getUserRoles(userId),
      rbacPrisma.departmentMember.findMany({
        where: { userId },
        include: { department: true },
      }),
      rbacPrisma.groupMember.findMany({
        where: { userId },
        include: { group: true },
      }),
    ]);

    const permissionSet = new Map<string, { resource: string; action: string; scope: string }>();
    
    for (const userRole of userRoles) {
      for (const rp of userRole.role.permissions) {
        const key = `${rp.permission.resource}:${rp.permission.action}:${rp.permission.scope}`;
        if (!permissionSet.has(key)) {
          permissionSet.set(key, {
            resource: rp.permission.resource,
            action: rp.permission.action,
            scope: rp.permission.scope,
          });
        }
      }
    }

    return {
      userId,
      roles: userRoles.map(ur => ur.role.name),
      roleLevel: Math.min(...userRoles.map(ur => ur.role.level), 999),
      departments: departmentMemberships.map(dm => dm.department.name),
      groups: groupMemberships.map(gm => gm.group.name),
      permissions: Array.from(permissionSet.values()),
    };
  }

  async checkPermission(
    userId: string,
    resource: string,
    action: string,
    scope?: string
  ): Promise<boolean> {
    const userRoles = await this.getUserRoles(userId);
    
    for (const userRole of userRoles) {
      const hasPermission = await permissionService.roleHasPermission(
        userRole.roleId,
        resource,
        action,
        scope
      );
      if (hasPermission) return true;
    }

    return false;
  }

  async hasRole(userId: string, roleNames: string[]): Promise<boolean> {
    const userRole = await rbacPrisma.userRole.findFirst({
      where: {
        userId,
        role: {
          name: { in: roleNames },
        },
      },
    });

    return !!userRole;
  }

  async getUserLevel(userId: string): Promise<number> {
    const userRoles = await this.getUserRoles(userId);
    if (userRoles.length === 0) return 999;
    
    return Math.min(...userRoles.map(ur => ur.role.level));
  }
}

export const userRoleService = new UserRoleService();
