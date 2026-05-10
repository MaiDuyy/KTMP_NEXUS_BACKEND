// services/identity-service/src/routes/org.routes.ts
// Migrated from rbac-service — department + RBAC group routes

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { departmentService, rbacGroupService } from '../services/org.service.js';

const router = Router();

// ==================== DEPARTMENTS ====================
router.get('/departments', async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await departmentService.getAllDepartments() }); } catch (e) { next(e); }
});

router.get('/departments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dept = await departmentService.getDepartmentById(req.params.id as string);
    if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });
    res.json({ success: true, data: dept });
  } catch (e) { next(e); }
});

router.post('/departments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ name: z.string().min(1).max(100), description: z.string().optional(), parentId: z.string().uuid().optional(), managerId: z.string().uuid().optional() }).parse(req.body);
    res.status(201).json({ success: true, data: await departmentService.createDepartment(data) });
  } catch (e) { next(e); }
});

router.put('/departments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ name: z.string().min(1).max(100).optional(), description: z.string().optional(), parentId: z.string().uuid().optional(), managerId: z.string().uuid().optional() }).parse(req.body);
    res.json({ success: true, data: await departmentService.updateDepartment(req.params.id as string, data) });
  } catch (e) { next(e); }
});

router.delete('/departments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try { await departmentService.deleteDepartment(req.params.id as string); res.json({ success: true, message: 'Department deleted' }); } catch (e) { next(e); }
});

router.post('/departments/:id/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, isPrimary } = z.object({ userId: z.string().uuid(), isPrimary: z.boolean().optional() }).parse(req.body);
    res.status(201).json({ success: true, data: await departmentService.addMember(req.params.id as string, userId, isPrimary) });
  } catch (e) { next(e); }
});

router.delete('/departments/:id/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try { await departmentService.removeMember(req.params.id as string, req.params.userId as string); res.json({ success: true, message: 'Member removed' }); } catch (e) { next(e); }
});

// ==================== RBAC GROUPS ====================
router.get('/groups', async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await rbacGroupService.getAllGroups() }); } catch (e) { next(e); }
});

router.get('/groups/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await rbacGroupService.getGroupById(req.params.id as string);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
    res.json({ success: true, data: group });
  } catch (e) { next(e); }
});

router.post('/groups', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ name: z.string().min(1).max(100), description: z.string().optional(), ownerId: z.string().uuid() }).parse(req.body);
    res.status(201).json({ success: true, data: await rbacGroupService.createGroup(data) });
  } catch (e) { next(e); }
});

router.put('/groups/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ name: z.string().min(1).max(100).optional(), description: z.string().optional(), isActive: z.boolean().optional() }).parse(req.body);
    res.json({ success: true, data: await rbacGroupService.updateGroup(req.params.id as string, data) });
  } catch (e) { next(e); }
});

router.delete('/groups/:id', async (req: Request, res: Response, next: NextFunction) => {
  try { await rbacGroupService.deleteGroup(req.params.id as string); res.json({ success: true, message: 'Group deleted' }); } catch (e) { next(e); }
});

router.post('/groups/:id/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, role } = z.object({ userId: z.string().uuid(), role: z.enum(['member', 'admin']).optional() }).parse(req.body);
    res.status(201).json({ success: true, data: await rbacGroupService.addMember(req.params.id as string, userId, role) });
  } catch (e) { next(e); }
});

router.delete('/groups/:id/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try { await rbacGroupService.removeMember(req.params.id as string, req.params.userId as string); res.json({ success: true, message: 'Member removed' }); } catch (e) { next(e); }
});

router.get('/users/:userId/org-info', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [departments, groups] = await Promise.all([
      departmentService.getUserDepartments(req.params.userId as string),
      rbacGroupService.getUserGroups(req.params.userId as string),
    ]);
    res.json({ success: true, data: { userId: req.params.userId, departments, groups } });
  } catch (e) { next(e); }
});

export { router as orgRoutes };
