import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { roleService } from '../services/role.service.js';
import { permissionService } from '../services/permission.service.js';
import { userRoleService } from '../services/user-role.service.js';
import { createError } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';

const router = Router();

// ==================== ROLE ENDPOINTS ====================

// GET /roles - List all roles
router.get('/roles', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const roles = await roleService.getAllRoles({ includePermissions: true });
    res.json({ success: true, data: roles });
  } catch (error) {
    next(error);
  }
});

// GET /roles/:id - Get role by ID
router.get('/roles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = await roleService.getRoleById(req.params.id as string, true);
    if (!role) {
      throw createError('Role not found', 404, 'ROLE_NOT_FOUND');
    }
    res.json({ success: true, data: role });
  } catch (error) {
    next(error);
  }
});

// POST /roles - Create a new role
const createRoleSchema = z.object({
  name: z.string().min(1).max(50),
  displayName: z.string().min(1).max(100),
  description: z.string().optional(),
  level: z.number().int().min(0).max(100),
});

router.post('/roles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createRoleSchema.parse(req.body);
    const role = await roleService.createRole(data);
    res.status(201).json({ success: true, data: role });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// PUT /roles/:id - Update a role
const updateRoleSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  level: z.number().int().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
});

router.put('/roles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateRoleSchema.parse(req.body);
    const role = await roleService.updateRole(req.params.id as string, data);
    res.json({ success: true, data: role });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /roles/:id - Delete (deactivate) a role
router.delete('/roles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await roleService.deleteRole(req.params.id as string);
    res.json({ success: true, message: 'Role deleted' });
  } catch (error) {
    next(error);
  }
});

// ==================== PERMISSION ENDPOINTS ====================

// GET /permissions - List all permissions
router.get('/permissions', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const permissions = await permissionService.getAllPermissions();
    res.json({ success: true, data: permissions });
  } catch (error) {
    next(error);
  }
});

// POST /roles/:id/permissions - Assign permissions to role
const assignPermissionsSchema = z.object({
  permissionIds: z.array(z.string().uuid()),
});

router.post('/roles/:id/permissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { permissionIds } = assignPermissionsSchema.parse(req.body);
    await roleService.assignPermissionsToRole(req.params.id as string, permissionIds);
    res.json({ success: true, message: 'Permissions assigned' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /roles/:id/permissions - Remove permissions from role
router.delete('/roles/:id/permissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { permissionIds } = assignPermissionsSchema.parse(req.body);
    await roleService.removePermissionsFromRole(req.params.id as string, permissionIds);
    res.json({ success: true, message: 'Permissions removed' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// ==================== USER ROLE ENDPOINTS ====================

// GET /users/:userId/roles - Get user's roles
router.get('/users/:userId/roles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userRoles = await userRoleService.getUserRoles(req.params.userId  as string);
    res.json({ success: true, data: userRoles });
  } catch (error) {
    next(error);
  }
});

// GET /users/:userId/permissions - Get user's aggregated permissions
router.get('/users/:userId/permissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const permissions = await userRoleService.getUserPermissions(req.params.userId as string);
    res.json({ success: true, data: permissions });
  } catch (error) {
    next(error);
  }
});

// POST /users/:userId/roles - Assign role to user
const assignRoleSchema = z.object({
  roleId: z.string().uuid(),
  grantedBy: z.string().uuid(),
  orgId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
});

router.post('/users/:userId/roles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = assignRoleSchema.parse(req.body);
    const userRole = await userRoleService.assignRole({
      userId: req.params.userId as string,
      roleId: data.roleId,
      grantedBy: data.grantedBy,
      orgId: data.orgId,
      workspaceId: data.workspaceId,
      departmentId: data.departmentId,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
    });
    res.status(201).json({ success: true, data: userRole });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /users/:userId/roles/:roleId - Revoke role from user
const revokeRoleSchema = z.object({
  revokedBy: z.string().uuid(),
});

router.delete('/users/:userId/roles/:roleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { revokedBy } = revokeRoleSchema.parse(req.body);
    await userRoleService.revokeRole(req.params.userId as string, req.params.roleId as string, revokedBy);
    res.json({ success: true, message: 'Role revoked' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// ==================== PERMISSION CHECK ENDPOINT ====================

// POST /check - Check if user has permission
const checkPermissionSchema = z.object({
  userId: z.string().uuid(),
  resource: z.string().min(1),
  action: z.string().min(1),
  scope: z.string().optional(),
});

router.post('/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, resource, action, scope } = checkPermissionSchema.parse(req.body);
    const hasPermission = await userRoleService.checkPermission(userId, resource, action, scope);
    res.json({ 
      success: true, 
      data: { 
        allowed: hasPermission,
        userId,
        resource,
        action,
        scope,
      } 
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// POST /check-role - Check if user has specific role(s)
const checkRoleSchema = z.object({
  userId: z.string().uuid(),
  roles: z.array(z.string()),
});

router.post('/check-role', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, roles } = checkRoleSchema.parse(req.body);
    const hasRole = await userRoleService.hasRole(userId, roles);
    res.json({ 
      success: true, 
      data: { 
        hasRole,
        userId,
        checkedRoles: roles,
      } 
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

export { router as rbacRoutes };
