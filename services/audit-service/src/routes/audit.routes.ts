import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { auditService } from '../services/audit.service.js';
import { createError } from '../middleware/errorHandler.js';

const router = Router();

// ==================== AUDIT LOG ENDPOINTS ====================

// POST /logs - Create audit log (for other services)
const createLogSchema = z.object({
  userId: z.string().uuid().optional(),
  userEmail: z.string().email().optional(),
  userRole: z.string().optional(),
  category: z.enum(['AUTH', 'USER_MGMT', 'ROLE_MGMT', 'DATA_ACCESS', 'DATA_MODIFY', 'DATA_DELETE', 'ADMIN', 'SECURITY', 'AI', 'EXPORT', 'SYSTEM']),
  action: z.string().min(1),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL', 'ALERT']).optional(),
  resource: z.string().min(1),
  resourceId: z.string().optional(),
  orgId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  details: z.record(z.unknown()).optional(),
  oldValue: z.record(z.unknown()).optional(),
  newValue: z.record(z.unknown()).optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  requestId: z.string().optional(),
  success: z.boolean().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

router.post('/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createLogSchema.parse(req.body);
    await auditService.log(data);
    res.status(201).json({ success: true, message: 'Audit logged' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// GET /logs - Query audit logs
router.get('/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, category, action, resource, severity, startDate, endDate, limit, offset } = req.query;
    
    const logs = await auditService.query({
      userId: userId as string,
      category: category as any,
      action: action as string,
      resource: resource as string,
      severity: severity as any,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });

    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
});

// GET /logs/:id - Get audit log by ID
router.get('/logs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const log = await auditService.getById(req.params.id);
    if (!log) {
      throw createError('Audit log not found', 404, 'NOT_FOUND');
    }
    res.json({ success: true, data: log });
  } catch (error) {
    next(error);
  }
});

// GET /users/:userId/logs - Get user's audit logs
router.get('/users/:userId/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const logs = await auditService.getUserLogs(req.params.userId, limit);
    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
});

// GET /resources/:resource/:resourceId/logs - Get resource's audit logs
router.get('/resources/:resource/:resourceId/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const logs = await auditService.getResourceLogs(req.params.resource, req.params.resourceId, limit);
    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
});

// ==================== SECURITY ALERTS ====================

// GET /alerts - Get security alerts
router.get('/alerts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string;
    const alerts = await auditService.getSecurityAlerts(status);
    res.json({ success: true, data: alerts });
  } catch (error) {
    next(error);
  }
});

// POST /alerts - Create security alert
const createAlertSchema = z.object({
  type: z.string().min(1),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL', 'ALERT']),
  userId: z.string().uuid().optional(),
  details: z.record(z.unknown()),
});

router.post('/alerts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createAlertSchema.parse(req.body);
    const alert = await auditService.createAlert(data);
    res.status(201).json({ success: true, data: alert });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// PUT /alerts/:id/resolve - Resolve security alert
const resolveAlertSchema = z.object({
  resolvedBy: z.string().uuid(),
  resolution: z.string().min(1),
});

router.put('/alerts/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { resolvedBy, resolution } = resolveAlertSchema.parse(req.body);
    const alert = await auditService.resolveAlert(req.params.id, resolvedBy, resolution);
    res.json({ success: true, data: alert });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// ==================== DM ACCESS LOGS ====================

// GET /dm-access - Get DM access logs
router.get('/dm-access', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accessedBy, conversationId, startDate, endDate } = req.query;
    
    const logs = await auditService.getDMAccessLogs({
      accessedBy: accessedBy as string,
      conversationId: conversationId as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    });

    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
});

// POST /dm-access - Log DM access
const dmAccessSchema = z.object({
  accessedBy: z.string().uuid(),
  conversationId: z.string().uuid(),
  participant1Id: z.string().uuid(),
  participant2Id: z.string().uuid(),
  reason: z.string().min(10),
  approvedBy: z.string().uuid().optional(),
  ipAddress: z.string().optional(),
  sessionId: z.string().optional(),
});

router.post('/dm-access', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = dmAccessSchema.parse(req.body);
    const log = await auditService.logDMAccess(data);
    res.status(201).json({ success: true, data: log });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// ==================== COMPLIANCE REPORTS ====================

// GET /reports - Get compliance reports
router.get('/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const type = req.query.type as string;
    const reports = await auditService.getReports(type);
    res.json({ success: true, data: reports });
  } catch (error) {
    next(error);
  }
});

// POST /reports - Generate compliance report
const generateReportSchema = z.object({
  type: z.string().min(1),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  generatedBy: z.string().uuid(),
});

router.post('/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, periodStart, periodEnd, generatedBy } = generateReportSchema.parse(req.body);
    const report = await auditService.generateReport(
      type,
      new Date(periodStart),
      new Date(periodEnd),
      generatedBy
    );
    res.status(201).json({ success: true, data: report });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

export { router as auditRoutes };
