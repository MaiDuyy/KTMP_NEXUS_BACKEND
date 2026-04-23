// services/userorg-service/src/middleware/audit.ts
// Audit logging middleware for admin actions

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';

// Audit event types
export type AuditAction =
  | 'USER_INVITED'
  | 'USER_SUSPENDED'
  | 'USER_UNSUSPENDED'
  | 'USER_DELETED'
  | 'USER_ANONYMIZED'
  | 'USER_ROLE_UPDATED'
  | 'INVITATION_CREATED'
  | 'INVITATION_REVOKED'
  | 'ORG_SETTINGS_UPDATED';

interface AuditLogEntry {
  action: AuditAction;
  performedBy: string;
  targetUserId?: string;
  targetResource?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: string;
}

/**
 * Log an audit event
 */
export async function logAuditEvent(entry: Omit<AuditLogEntry, 'timestamp'>) {
  const auditEntry: AuditLogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  // Log locally
  logger.info(
    { audit: auditEntry },
    `Audit: ${entry.action} by ${entry.performedBy}`
  );

  // Publish to NATS for centralized audit logging
  try {
    await publishEvent(EventSubjects.AUDIT_LOG || 'audit.log', auditEntry);
  } catch (error) {
    logger.error({ error, audit: auditEntry }, 'Failed to publish audit event');
  }
}

/**
 * Middleware factory to automatically log audit events after route execution
 */
export function auditLog(action: AuditAction, options?: {
  getTargetUserId?: (req: Request) => string | undefined;
  getDetails?: (req: Request, res: Response) => Record<string, unknown>;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json to log after successful response
    res.json = function (body: unknown) {
      // Only log on successful operations
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const userId = req.headers['x-user-id'] as string;
        const targetUserId = options?.getTargetUserId?.(req);
        const details = options?.getDetails?.(req, res);

        logAuditEvent({
          action,
          performedBy: userId || 'unknown',
          targetUserId,
          details: {
            ...details,
            responseStatus: res.statusCode,
          },
          ipAddress: req.ip || req.headers['x-forwarded-for'] as string,
          userAgent: req.headers['user-agent'],
        });
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * Pre-built audit middleware for common actions
 */
export const AuditMiddleware = {
  userSuspended: auditLog('USER_SUSPENDED', {
    getTargetUserId: (req) => req.params.id as string,
    getDetails: (req) => ({ reason: req.body.reason }),
  }),

  userUnsuspended: auditLog('USER_UNSUSPENDED', {
    getTargetUserId: (req) => req.params.id as string,
  }),

  userDeleted: auditLog('USER_DELETED', {
    getTargetUserId: (req) => req.params.id as string,
    getDetails: (req) => ({ anonymize: req.query.anonymize === 'true' }),
  }),

  userRoleUpdated: auditLog('USER_ROLE_UPDATED', {
    getTargetUserId: (req) => req.params.id as string,
    getDetails: (req) => ({ newRole: req.body.role }),
  }),

  invitationCreated: auditLog('INVITATION_CREATED', {
    getDetails: (req) => ({
      email: req.body.email,
      type: req.body.type,
    }),
  }),

  invitationRevoked: auditLog('INVITATION_REVOKED', {
    getDetails: (req) => ({ invitationId: req.params.id }),
  }),

  orgSettingsUpdated: auditLog('ORG_SETTINGS_UPDATED', {
    getDetails: (req) => ({ changes: Object.keys(req.body) }),
  }),
};
