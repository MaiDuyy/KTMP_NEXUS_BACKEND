import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent, RBACEventSubjects } from '../lib/nats.js';
import { permissionService } from './permission.service.js';
import type { UserRole, Role, Permission, RolePermission } from '@prisma/client';

// Type for UserRole with included Role and Permissions
type UserRoleWithRole = UserRole & {
  role: Role & {
    permissions: (RolePermission & {
      permission: Permission;
    })[];
  };
};

export interface UserPermissions {
  userId: string;
  roles: string[];
  roleLevel: number; // Lowest level = highest privilege
  departments: string[];
  groups: string[];
  permissions: Array<{
    resource: string;
    action: string;
    scope: string;
  }>;
}

export class UserRoleService {
  // Get all roles for a user (with included relations)
  async getUserRoles(userId: string): Promise<UserRoleWithRole[]> {
    return prisma.userRole.findMany({
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
    }) as Promise<UserRoleWithRole[]>;
  }

  // Assign role to user
  async assignRole(data: {
    userId: string;
    roleId: string;
    grantedBy: string;
    orgId?: string;
    workspaceId?: string;
    departmentId?: string;
    expiresAt?: Date;
  }): Promise<UserRole> {
    // Check if role exists
    const role = await prisma.role.findUnique({ where: { id: data.roleId } });
    if (!role) {
      throw new Error('Role not found');
    }

    // Check if assigner has higher privilege (lower level)
    // Skip privilege check for system-initiated assignments (e.g., signup) or self-registration
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

    const userRole = await prisma.userRole.create({
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

    logger.info({ userId: data.userId, roleId: data.roleId }, 'Role assigned to user');
    return userRole;
  }

  // Revoke role from user
  async revokeRole(userId: string, roleId: string, revokedBy: string): Promise<void> {
    const userRole = await prisma.userRole.findFirst({
      where: { userId, roleId },
      include: { role: true },
    });

    if (!userRole) {
      throw new Error('User does not have this role');
    }

    // Check if revoker has higher privilege
    const revokerRoles = await this.getUserRoles(revokedBy);
    const revokerLevel = Math.min(...revokerRoles.map(ur => ur.role.level), Infinity);
    
    if (revokerLevel >= userRole.role.level) {
      throw new Error('Cannot revoke role with equal or higher privilege');
    }

    await prisma.userRole.delete({
      where: { id: userRole.id },
    });

    await publishEvent(RBACEventSubjects.ROLE_REVOKED, {
      userId,
      roleId,
      roleName: userRole.role.name,
      revokedBy,
    });

    logger.info({ userId, roleId }, 'Role revoked from user');
  }

  // Get full user permissions (aggregated from all roles)
  async getUserPermissions(userId: string): Promise<UserPermissions> {
    const [userRoles, departmentMemberships, groupMemberships] = await Promise.all([
      this.getUserRoles(userId),
      prisma.departmentMember.findMany({
        where: { userId },
        include: { department: true },
      }),
      prisma.groupMember.findMany({
        where: { userId },
        include: { group: true },
      }),
    ]);

    // Aggregate permissions from all roles
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

  // Check if user has specific permission
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

  // Check if user has any of the specified roles
  async hasRole(userId: string, roleNames: string[]): Promise<boolean> {
    const userRole = await prisma.userRole.findFirst({
      where: {
        userId,
        role: {
          name: { in: roleNames },
        },
      },
    });

    return !!userRole;
  }

  // Get user's highest privilege level
  async getUserLevel(userId: string): Promise<number> {
    const userRoles = await this.getUserRoles(userId);
    if (userRoles.length === 0) return 999; // No roles = lowest privilege
    
    return Math.min(...userRoles.map(ur => ur.role.level));
  }
}

export const userRoleService = new UserRoleService();
