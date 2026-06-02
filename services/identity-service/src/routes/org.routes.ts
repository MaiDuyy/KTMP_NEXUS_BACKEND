// services/identity-service/src/routes/org.routes.ts
// Migrated from rbac-service — department + RBAC group routes

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { departmentService, rbacGroupService, departmentInvitationService } from '../services/org.service.js';
import { rbacPrisma } from '../lib/prisma.js';

const router = Router();

// Reusable permission helper for department-level operations (Least Privilege)
async function checkDeptPermission(
  actorId: string,
  actorRole: string,
  departmentId: string,
  targetUserId?: string,
  targetRole?: string
): Promise<void> {
  // 1. System administrators bypass all checks
  if (actorRole === 'SUPER_ADMIN' || actorRole === 'ADMIN') {
    return;
  }

  // 2. Fetch actor's role in this department
  const actorMember = await rbacPrisma.departmentMember.findUnique({
    where: { userId_departmentId: { userId: actorId, departmentId } }
  });
  if (!actorMember) {
    throw new Error('Bạn không có quyền thực hiện vì không phải là thành viên của phòng ban này!');
  }

  const deptRole = actorMember.role; // 'HEAD', 'MANAGER', 'MEMBER', 'GUEST'

  // 3. Regular Members and Guests cannot manage department members
  if (deptRole === 'MEMBER' || deptRole === 'GUEST') {
    throw new Error('Bạn không có quyền quản lý nhân sự trong phòng ban này!');
  }

  // 4. If targeting another user
  if (targetUserId) {
    if (targetUserId === actorId) {
      throw new Error('Bạn không thể tự chỉnh sửa vai trò của chính mình!');
    }

    // Fetch target's current department role (if they exist)
    const targetMember = await rbacPrisma.departmentMember.findUnique({
      where: { userId_departmentId: { userId: targetUserId, departmentId } }
    });
    const currentTargetRole = targetMember ? targetMember.role : null;

    // Check Dept Admin (MANAGER) constraints:
    if (deptRole === 'MANAGER') {
      // MANAGER cannot assign HEAD or MANAGER roles!
      if (targetRole && ['HEAD', 'MANAGER'].includes(targetRole)) {
        throw new Error('Trưởng phòng phó không được phép bổ nhiệm vai trò Trưởng phòng hoặc Phó phòng khác!');
      }

      // MANAGER cannot modify or demote a Dept Head or another Dept Admin!
      if (currentTargetRole && ['HEAD', 'MANAGER'].includes(currentTargetRole)) {
        throw new Error('Trưởng phòng phó không được phép chỉnh sửa nhân sự quản lý cấp cao hơn hoặc tương đương!');
      }
    }
  }
}

const nullableUuid = z.preprocess(
  (val) => {
    if (val === '' || val === 'none_manager' || val === 'none_parent' || val === 'null' || val === null || val === undefined) {
      return null;
    }
    return val;
  },
  z.string().nullable().optional()
);

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
    const data = z.object({
      name: z.string().min(1).max(100),
      description: z.string().nullable().optional(),
      parentId: nullableUuid,
      managerId: nullableUuid
    }).parse(req.body);
    res.status(201).json({ success: true, data: await departmentService.createDepartment(data) });
  } catch (e) { next(e); }
});

router.put('/departments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().nullable().optional(),
      parentId: nullableUuid,
      managerId: nullableUuid
    }).parse(req.body);
    res.json({ success: true, data: await departmentService.updateDepartment(req.params.id as string, data) });
  } catch (e) { next(e); }
});

router.delete('/departments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try { await departmentService.deleteDepartment(req.params.id as string); res.json({ success: true, message: 'Department deleted' }); } catch (e) { next(e); }
});

router.post('/departments/:id/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currentUserId = req.headers['x-user-id'] as string;
    const currentUserRole = req.headers['x-user-role'] as string;
    if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

    const { userId, role, isPrimary } = z.object({
      userId: z.preprocess((v) => (v === '' ? undefined : v), z.string().uuid()),
      role: z.enum(['HEAD', 'MANAGER', 'MEMBER', 'GUEST']).optional(),
      isPrimary: z.boolean().optional()
    }).parse(req.body);

    const targetRole = role || 'MEMBER';

    // Verify permission (Least Privilege Guard)
    await checkDeptPermission(currentUserId, currentUserRole, req.params.id as string, userId, targetRole);

    res.status(201).json({ success: true, data: await departmentService.addMember(req.params.id as string, userId, targetRole, isPrimary, currentUserId) });
  } catch (e: any) {
    const isPermissionError = e.message.includes('quyền') || e.message.includes('chỉnh sửa') || e.message.includes('bổ nhiệm');
    const isConflictError = e.message.includes('đang thuộc') || e.message.includes('thành viên chính thức');
    const status = isPermissionError ? 403 : isConflictError ? 409 : 422;
    res.status(status).json({ success: false, message: e.message });
  }
});

// PATCH /departments/:id/members/:userId - Update member role
router.patch('/departments/:id/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currentUserId = req.headers['x-user-id'] as string;
    const currentUserRole = req.headers['x-user-role'] as string;
    if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

    const { role } = z.object({
      role: z.enum(['HEAD', 'MANAGER', 'MEMBER', 'GUEST'])
    }).parse(req.body);

    // Verify permission (Least Privilege Guard)
    await checkDeptPermission(currentUserId, currentUserRole, req.params.id as string, req.params.userId as string, role);

    const updated = await departmentService.addMember(req.params.id as string, req.params.userId as string, role, false, currentUserId);
    res.json({ success: true, data: updated });
  } catch (e: any) {
    const isPermissionError = e.message.includes('quyền') || e.message.includes('chỉnh sửa') || e.message.includes('bổ nhiệm');
    const isConflictError = e.message.includes('đang thuộc') || e.message.includes('thành viên chính thức');
    const status = isPermissionError ? 403 : isConflictError ? 409 : 422;
    res.status(status).json({ success: false, message: e.message });
  }
});

router.delete('/departments/:id/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currentUserId = req.headers['x-user-id'] as string;
    const currentUserRole = req.headers['x-user-role'] as string;
    if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

    // Verify permission (Least Privilege Guard)
    await checkDeptPermission(currentUserId, currentUserRole, req.params.id as string, req.params.userId as string);

    await departmentService.removeMember(req.params.id as string, req.params.userId as string, currentUserId);
    res.json({ success: true, message: 'Member removed' });
  } catch (e: any) {
    const isPermissionError = e.message.includes('quyền') || e.message.includes('chỉnh sửa');
    const status = isPermissionError ? 403 : 422;
    res.status(status).json({ success: false, message: e.message });
  }
});

// Mới nhân sự vào phòng ban qua email (Flow C)
router.post('/departments/:id/invitations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitedBy = req.headers['x-user-id'] as string;
    if (!invitedBy) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

    const { email, role } = z.object({
      email: z.string().email('Email không đúng định dạng!'),
      role: z.enum(['HEAD', 'MANAGER', 'MEMBER', 'GUEST']).optional()
    }).parse(req.body);

    const invite = await departmentInvitationService.createInvitation({
      departmentId: req.params.id as string,
      email,
      role: role || 'MEMBER',
      invitedBy,
    });

    res.status(201).json({ success: true, message: 'Đã gửi lời mời tham gia phòng ban!', data: invite });
  } catch (e) { next(e); }
});

// Danh sách lời mời của phòng ban
router.get('/departments/:id/invitations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await departmentInvitationService.listInvitations(req.params.id as string);
    res.json({ success: true, data });
  } catch (e) { next(e); }
});

// Kiểm tra token mời vào phòng ban
router.get('/departments/invitations/validate/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invite = await departmentInvitationService.validateInvitation(req.params.token as string);
    if (!invite) return res.status(404).json({ success: false, message: 'Lời mời không hợp lệ!' });
    res.json({ success: true, data: invite, userExists: invite.userExists });
  } catch (e) { next(e); }
});

// Chấp nhận lời mời phòng ban (Flow C)
router.post('/departments/invitations/accept/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, password, gender } = z.object({
      name: z.string().min(1, 'Tên không được để trống!').optional(),
      password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự!').optional(),
      gender: z.enum(['male', 'female', 'other']).optional(),
    }).parse(req.body);

    const result = await departmentInvitationService.acceptInvitation(req.params.token as string, {
      name: name || '',
      password,
      gender,
    });

    res.json(result);
  } catch (e) { next(e); }
});

// Từ chối lời mời phòng ban
router.post('/departments/invitations/reject/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await departmentInvitationService.rejectInvitation(req.params.token as string);
    res.json(result);
  } catch (e) { next(e); }
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

router.get('/users/:userId/departments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const depts = await departmentService.getUserDetailedDepartments(req.params.userId as string);
    res.json({ success: true, data: depts });
  } catch (e) { next(e); }
});

export { router as orgRoutes };
