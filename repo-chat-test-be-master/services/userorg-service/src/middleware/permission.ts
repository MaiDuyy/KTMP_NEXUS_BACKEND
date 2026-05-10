// services/userorg-service/src/middleware/permission.ts
// RBAC Permission middleware for protected routes

import type { Request, Response, NextFunction } from 'express';
import { rbacClient } from '../lib/rbac-client.js';
import { logger } from '../lib/logger.js';

// Permission definitions for Module 3 features
export const Permissions = {
  // User management
  USER_INVITE: { resource: 'user', action: 'invite' },
  USER_SUSPEND: { resource: 'user', action: 'suspend' },
  USER_DELETE: { resource: 'user', action: 'delete' },
  USER_ANONYMIZE: { resource: 'user', action: 'anonymize' },
  USER_VIEW_ALL: { resource: 'user', action: 'viewAll' },
  USER_UPDATE_ROLE: { resource: 'user', action: 'updateRole' },

  // Org settings
  ORG_SETTINGS_VIEW: { resource: 'org', action: 'viewSettings' },
  ORG_SETTINGS_UPDATE: { resource: 'org', action: 'updateSettings' },

  // Invitation management
  INVITATION_CREATE: { resource: 'invitation', action: 'create' },
  INVITATION_REVOKE: { resource: 'invitation', action: 'revoke' },
  INVITATION_LIST: { resource: 'invitation', action: 'list' },
} as const;

type PermissionKey = keyof typeof Permissions;

/**
 * Middleware factory to check RBAC permissions
 */
export function requirePermission(permissionKey: PermissionKey) {
  const { resource, action } = Permissions[permissionKey];

  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.headers['x-user-id'] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Chưa đăng nhập!',
      });
    }

    try {
      const hasPermission = await rbacClient.checkPermission(
        userId,
        resource,
        action
      );

      if (!hasPermission) {
        logger.warn({ userId, resource, action }, 'Permission denied');
        return res.status(403).json({
          success: false,
          message: 'Bạn không có quyền thực hiện thao tác này!',
        });
      }

      next();
    } catch (error) {
      logger.error({ error, userId, resource, action }, 'Permission check failed');
      // Fallback: deny access if RBAC service is unavailable
      return res.status(503).json({
        success: false,
        message: 'Không thể kiểm tra quyền. Vui lòng thử lại sau.',
      });
    }
  };
}

/**
 * Middleware factory to check if user has any of the specified roles
 */
export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.headers['x-user-id'] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Chưa đăng nhập!',
      });
    }

    try {
      const hasRole = await rbacClient.hasRole(userId, roles);

      if (!hasRole) {
        logger.warn({ userId, roles }, 'Role check failed');
        return res.status(403).json({
          success: false,
          message: 'Bạn không có quyền thực hiện thao tác này!',
        });
      }

      next();
    } catch (error) {
      logger.error({ error, userId, roles }, 'Role check failed');
      return res.status(503).json({
        success: false,
        message: 'Không thể kiểm tra quyền. Vui lòng thử lại sau.',
      });
    }
  };
}

/**
 * Middleware to require Super Admin role
 */
export const requireSuperAdmin = requireRole('SUPER_ADMIN');

/**
 * Middleware to require Admin or Super Admin role
 */
export const requireAdmin = requireRole('ADMIN', 'SUPER_ADMIN', 'WORKSPACE_MANAGER');
