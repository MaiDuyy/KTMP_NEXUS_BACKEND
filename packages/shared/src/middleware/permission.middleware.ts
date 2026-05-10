// packages/shared/src/middleware/permission.middleware.ts
// Permission middleware for Express routes

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { TokenPayload, SystemRole, ROLE_LEVELS } from '../types/rbac.types.js';
import { PermissionString, matchesPermission } from '../constants/permissions.js';

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

// Auth config from environment
const getAuthSecret = () => process.env.JWT_SECRET || process.env.AUTH_SECRET || 'secret';

/**
 * Middleware to verify JWT token and attach user to request
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: { message: 'No token provided', code: 'NO_TOKEN' },
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, getAuthSecret()) as TokenPayload;
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: { message: 'Invalid or expired token', code: 'INVALID_TOKEN' },
    });
  }
}

/**
 * Middleware to require specific role(s)
 * Uses RBAC roles if available, falls back to legacy role
 */
export function requireRole(...allowedRoles: (SystemRole | string)[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required', code: 'AUTH_REQUIRED' },
      });
      return;
    }

    // Check RBAC roles first
    if (req.user.roles?.length) {
      const hasRole = req.user.roles.some(role => allowedRoles.includes(role));
      if (hasRole) {
        next();
        return;
      }
    }

    // Fallback to legacy role
    if (allowedRoles.includes(req.user.role)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      error: { message: 'Insufficient role', code: 'FORBIDDEN' },
    });
  };
}

/**
 * Middleware to require minimum role level
 * Lower level = higher privilege (SUPER_ADMIN = 0)
 */
export function requireLevel(maxLevel: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required', code: 'AUTH_REQUIRED' },
      });
      return;
    }

    // Check RBAC role level
    const userLevel = req.user.roleLevel ?? 999;
    
    if (userLevel <= maxLevel) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      error: { message: 'Insufficient privilege level', code: 'FORBIDDEN' },
    });
  };
}

/**
 * Options for permission check
 */
interface PermissionCheckOptions {
  // RBAC service URL for dynamic permission check
  rbacServiceUrl?: string;
  // Fallback: allow if RBAC service is unavailable
  allowOnRBACFailure?: boolean;
}

/**
 * Middleware to check specific permission
 * Checks against permissions in token
 */
export function requirePermission(
  permission: PermissionString,
  _options?: PermissionCheckOptions
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required', code: 'AUTH_REQUIRED' },
      });
      return;
    }

    // SUPER_ADMIN bypasses all permission checks
    if (req.user.roles?.includes(SystemRole.SUPER_ADMIN)) {
      next();
      return;
    }

    // For now, use role-based check as fallback
    // TODO: Implement full permission check via RBAC service
    const [resource, action] = permission.split(':');
    
    // Simple role-based permission mapping
    const rolePermissions: Record<string, string[]> = {
      [SystemRole.SUPER_ADMIN]: ['user', 'chat', 'knowledge', 'audit', 'ai', 'role'],
      [SystemRole.ADMIN]: ['user', 'chat', 'knowledge', 'audit', 'ai'],
      [SystemRole.WORKSPACE_OWNER]: ['chat', 'workspace:manage', 'audit', 'knowledge'],
      [SystemRole.WORKSPACE_ADMIN]: ['chat', 'workspace:manage', 'knowledge'],
      [SystemRole.WORKSPACE_MEMBER]: ['user:own', 'chat', 'knowledge:acl', 'ai'],
      [SystemRole.WORKSPACE_GUEST]: ['chat:member'],
    };

    const userRoles = req.user.roles || [req.user.role];
    
    for (const role of userRoles) {
      const perms = rolePermissions[role] || [];
      for (const perm of perms) {
        if (resource.startsWith(perm) || perm.startsWith(resource)) {
          next();
          return;
        }
      }
    }

    res.status(403).json({
      success: false,
      error: { 
        message: `Permission denied: ${permission}`, 
        code: 'PERMISSION_DENIED' 
      },
    });
  };
}

/**
 * Combine multiple permission checks (all must pass)
 */
export function requireAllPermissions(...permissions: PermissionString[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    for (const permission of permissions) {
      const checkResult = await new Promise<boolean>((resolve) => {
        const mockRes = {
          status: () => ({ json: () => resolve(false) }),
        } as unknown as Response;
        const mockNext = () => resolve(true);
        requirePermission(permission)(req, mockRes, mockNext as NextFunction);
      });

      if (!checkResult) {
        res.status(403).json({
          success: false,
          error: { 
            message: `Permission denied: ${permission}`, 
            code: 'PERMISSION_DENIED' 
          },
        });
        return;
      }
    }
    next();
  };
}

/**
 * Combine multiple permission checks (any must pass)
 */
export function requireAnyPermission(...permissions: PermissionString[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    for (const permission of permissions) {
      const checkResult = await new Promise<boolean>((resolve) => {
        const mockRes = {
          status: () => ({ json: () => resolve(false) }),
        } as unknown as Response;
        const mockNext = () => resolve(true);
        requirePermission(permission)(req, mockRes, mockNext as NextFunction);
      });

      if (checkResult) {
        next();
        return;
      }
    }

    res.status(403).json({
      success: false,
      error: { 
        message: 'Permission denied', 
        code: 'PERMISSION_DENIED' 
      },
    });
  };
}
