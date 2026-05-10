// services/identity-service/src/routes/rbac.routes.ts
// Migrated from rbac-service — uses identity-service services

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { roleService } from '../services/role.service.js';
import { permissionService } from '../services/permission.service.js';
import { userRoleService } from '../services/user-role.service.js';

const router = Router();

function createError(message: string, statusCode: number, code: string) {
  const err = new Error(message) as any;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

// ==================== ROLES ====================
router.get('/roles', async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await roleService.getAllRoles({ includePermissions: true }) }); } catch (e) { next(e); }
});

router.get('/roles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = await roleService.getRoleById(req.params.id as string, true);
    if (!role) throw createError('Role not found', 404, 'ROLE_NOT_FOUND');
    res.json({ success: true, data: role });
  } catch (e) { next(e); }
});

router.post('/roles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ name: z.string().min(1).max(50), displayName: z.string().min(1).max(100), description: z.string().optional(), level: z.number().int().min(0).max(100) }).parse(req.body);
    res.status(201).json({ success: true, data: await roleService.createRole(data) });
  } catch (e) { next(e); }
});

router.put('/roles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ displayName: z.string().min(1).max(100).optional(), description: z.string().optional(), level: z.number().int().min(0).max(100).optional(), isActive: z.boolean().optional() }).parse(req.body);
    res.json({ success: true, data: await roleService.updateRole(req.params.id as string, data) });
  } catch (e) { next(e); }
});

router.delete('/roles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try { await roleService.deleteRole(req.params.id as string); res.json({ success: true, message: 'Role deleted' }); } catch (e) { next(e); }
});

// ==================== PERMISSIONS ====================
router.get('/permissions', async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await permissionService.getAllPermissions() }); } catch (e) { next(e); }
});

router.post('/roles/:id/permissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { permissionIds } = z.object({ permissionIds: z.array(z.string().uuid()) }).parse(req.body);
    await roleService.assignPermissionsToRole(req.params.id as string, permissionIds);
    res.json({ success: true, message: 'Permissions assigned' });
  } catch (e) { next(e); }
});

router.delete('/roles/:id/permissions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { permissionIds } = z.object({ permissionIds: z.array(z.string().uuid()) }).parse(req.body);
    await roleService.removePermissionsFromRole(req.params.id as string, permissionIds);
    res.json({ success: true, message: 'Permissions removed' });
  } catch (e) { next(e); }
});

// ==================== USER ROLES ====================
router.get('/users/:userId/roles', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await userRoleService.getUserRoles(req.params.userId as string) }); } catch (e) { next(e); }
});

router.get('/users/:userId/permissions', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await userRoleService.getUserPermissions(req.params.userId as string) }); } catch (e) { next(e); }
});

router.post('/users/:userId/roles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ roleId: z.string().uuid(), grantedBy: z.string().uuid(), orgId: z.string().uuid().optional(), workspaceId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), expiresAt: z.string().datetime().optional() }).parse(req.body);
    const userRole = await userRoleService.assignRole({ userId: req.params.userId as string, ...data, expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined });
    res.status(201).json({ success: true, data: userRole });
  } catch (e) { next(e); }
});

router.delete('/users/:userId/roles/:roleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { revokedBy } = z.object({ revokedBy: z.string().uuid() }).parse(req.body);
    await userRoleService.revokeRole(req.params.userId as string, req.params.roleId as string, revokedBy);
    res.json({ success: true, message: 'Role revoked' });
  } catch (e) { next(e); }
});

// ==================== PERMISSION CHECKS ====================
router.post('/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, resource, action, scope } = z.object({ userId: z.string().uuid(), resource: z.string().min(1), action: z.string().min(1), scope: z.string().optional() }).parse(req.body);
    const allowed = await userRoleService.checkPermission(userId, resource, action, scope);
    res.json({ success: true, data: { allowed, userId, resource, action, scope } });
  } catch (e) { next(e); }
});

router.post('/check-role', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, roles } = z.object({ userId: z.string().uuid(), roles: z.array(z.string()) }).parse(req.body);
    const hasRole = await userRoleService.hasRole(userId, roles);
    res.json({ success: true, data: { hasRole, userId, checkedRoles: roles } });
  } catch (e) { next(e); }
});

export { router as rbacRoutes };
