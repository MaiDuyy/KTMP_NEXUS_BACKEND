// services/identity-service/src/routes/audit.routes.ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { auditLogService } from '../services/audit.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const auditRoutes = Router();

// GET /api/audit/logs
auditRoutes.get('/logs', asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const action = req.query.action as string;
  const resource = req.query.resource as string;
  const userId = req.query.userId as string;
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;

  const result = await auditLogService.getLogs({
    page,
    limit,
    action,
    resource,
    userId,
    startDate,
    endDate
  });

  res.json(result);
}));

// GET /api/audit/logs/:id
auditRoutes.get('/logs/:id', asyncHandler(async (req: Request, res: Response) => {
  const result = await auditLogService.getLogById(req.params.id as string);
  res.json(result);
}));

// GET /api/audit/users/:userId/logs
auditRoutes.get('/users/:userId/logs', asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  
  const result = await auditLogService.getLogs({
    page,
    limit,
    userId: req.params.userId as string
  });

  res.json(result);
}));

// GET /api/audit/resources/:resource/:resourceId/logs
auditRoutes.get('/resources/:resource/:resourceId/logs', asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  
  const result = await auditLogService.getLogs({
    page,
    limit,
    resource: req.params.resource as string,
    // We could add resourceId filter if the model supported it, 
    // but currently it's likely stored in the 'data' JSON.
  });

  res.json(result);
}));
