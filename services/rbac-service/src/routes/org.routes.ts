import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { departmentService, groupService } from '../services/org.service.js';
import { createError } from '../middleware/errorHandler.js';

const router = Router();

// ==================== DEPARTMENT ENDPOINTS ====================

// GET /departments - List all departments
router.get('/departments', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const departments = await departmentService.getAllDepartments();
    res.json({ success: true, data: departments });
  } catch (error) {
    next(error);
  }
});

// GET /departments/:id - Get department by ID
router.get('/departments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const department = await departmentService.getDepartmentById(req.params.id as string);
    if (!department) {
      throw createError('Department not found', 404, 'DEPT_NOT_FOUND');
    }
    res.json({ success: true, data: department });
  } catch (error) {
    next(error);
  }
});

// POST /departments - Create department
const createDepartmentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  parentId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
});

router.post('/departments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createDepartmentSchema.parse(req.body);
    const department = await departmentService.createDepartment(data);
    res.status(201).json({ success: true, data: department });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// PUT /departments/:id - Update department
router.put('/departments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createDepartmentSchema.partial().parse(req.body);
    const department = await departmentService.updateDepartment(req.params.id as string, data);
    res.json({ success: true, data: department });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /departments/:id - Delete department
router.delete('/departments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await departmentService.deleteDepartment(req.params.id as string);
    res.json({ success: true, message: 'Department deleted' });
  } catch (error) {
    next(error);
  }
});

// POST /departments/:id/members - Add member to department
const addMemberSchema = z.object({
  userId: z.string().uuid(),
  isPrimary: z.boolean().optional(),
});

router.post('/departments/:id/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, isPrimary } = addMemberSchema.parse(req.body);
    const member = await departmentService.addMember(req.params.id as string, userId, isPrimary);
    res.status(201).json({ success: true, data: member });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /departments/:id/members/:userId - Remove member from department
router.delete('/departments/:id/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await departmentService.removeMember(req.params.id as string, req.params.userId as string);
    res.json({ success: true, message: 'Member removed' });
  } catch (error) {
    next(error);
  }
});

// ==================== GROUP ENDPOINTS ====================

// GET /groups - List all groups
router.get('/groups', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const groups = await groupService.getAllGroups();
    res.json({ success: true, data: groups });
  } catch (error) {
    next(error);
  }
});

// GET /groups/:id - Get group by ID
router.get('/groups/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await groupService.getGroupById(req.params.id as string);
    if (!group) {
      throw createError('Group not found', 404, 'GROUP_NOT_FOUND');
    }
    res.json({ success: true, data: group });
  } catch (error) {
    next(error);
  }
});

// POST /groups - Create group
const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  ownerId: z.string().uuid(),
});

router.post('/groups', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createGroupSchema.parse(req.body);
    const group = await groupService.createGroup(data);
    res.status(201).json({ success: true, data: group });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// PUT /groups/:id - Update group
const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

router.put('/groups/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateGroupSchema.parse(req.body);
    const group = await groupService.updateGroup(req.params.id as string, data);
    res.json({ success: true, data: group });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /groups/:id - Delete (deactivate) group
router.delete('/groups/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await groupService.deleteGroup(req.params.id as string);
    res.json({ success: true, message: 'Group deleted' });
  } catch (error) {
    next(error);
  }
});

// POST /groups/:id/members - Add member to group
const addGroupMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['member', 'admin']).optional(),
});

router.post('/groups/:id/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, role } = addGroupMemberSchema.parse(req.body);
    const member = await groupService.addMember(req.params.id as string, userId, role);
    res.status(201).json({ success: true, data: member });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /groups/:id/members/:userId - Remove member from group
router.delete('/groups/:id/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await groupService.removeMember(req.params.id as string, req.params.userId as string);
    res.json({ success: true, message: 'Member removed' });
  } catch (error) {
    next(error);
  }
});

// GET /users/:userId/org-info - Get user's department and group memberships
router.get('/users/:userId/org-info', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [departments, groups] = await Promise.all([
      departmentService.getUserDepartments(req.params.userId as string),
      groupService.getUserGroups(req.params.userId as string),
    ]);
    res.json({ 
      success: true, 
      data: { 
        userId: req.params.userId,
        departments,
        groups,
      } 
    });
  } catch (error) {
    next(error);
  }
});

export { router as orgRoutes };
