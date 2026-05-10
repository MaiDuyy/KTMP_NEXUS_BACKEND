import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { AuditCategory, AuditSeverity } from '@prisma/client';

export interface AuditLogEntry {
  userId?: string;
  userEmail?: string;
  userRole?: string;
  category: AuditCategory;
  action: string;
  severity?: AuditSeverity;
  resource: string;
  resourceId?: string;
  orgId?: string;
  workspaceId?: string;
  details?: Record<string, unknown>;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  success?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export class AuditService {
  // Create audit log entry
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          userId: entry.userId,
          userEmail: entry.userEmail,
          userRole: entry.userRole,
          category: entry.category,
          action: entry.action,
          severity: entry.severity || 'INFO',
          resource: entry.resource,
          resourceId: entry.resourceId,
          orgId: entry.orgId,
          workspaceId: entry.workspaceId,
          details: entry.details as any,
          oldValue: entry.oldValue as any,
          newValue: entry.newValue as any,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          requestId: entry.requestId,
          success: entry.success ?? true,
          errorCode: entry.errorCode,
          errorMessage: entry.errorMessage,
        },
      });
      
      logger.debug({ action: entry.action, resource: entry.resource }, 'Audit logged');
    } catch (error) {
      logger.error({ error, entry }, 'Failed to log audit');
    }
  }

  // Query audit logs
  async query(filters: {
    userId?: string;
    category?: AuditCategory;
    action?: string;
    resource?: string;
    severity?: AuditSeverity;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }) {
    return prisma.auditLog.findMany({
      where: {
        userId: filters.userId,
        category: filters.category,
        action: filters.action,
        resource: filters.resource,
        severity: filters.severity,
        createdAt: {
          gte: filters.startDate,
          lte: filters.endDate,
        },
      },
      take: filters.limit || 100,
      skip: filters.offset || 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Get audit log by ID
  async getById(id: string) {
    return prisma.auditLog.findUnique({ where: { id } });
  }

  // Get logs for a specific user
  async getUserLogs(userId: string, limit = 50) {
    return prisma.auditLog.findMany({
      where: { userId },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Get logs for a specific resource
  async getResourceLogs(resource: string, resourceId: string, limit = 50) {
    return prisma.auditLog.findMany({
      where: { resource, resourceId },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Get security alerts
  async getSecurityAlerts(status?: string) {
    return prisma.securityAlert.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Create security alert
  async createAlert(data: {
    type: string;
    severity: AuditSeverity;
    userId?: string;
    details: Record<string, unknown>;
  }) {
    const alert = await prisma.securityAlert.create({
      data: {
        type: data.type,
        severity: data.severity,
        userId: data.userId,
        details: data.details as any,
      },
    });

    logger.warn({ alertId: alert.id, type: data.type }, 'Security alert created');
    return alert;
  }

  // Resolve security alert
  async resolveAlert(id: string, resolvedBy: string, resolution: string) {
    return prisma.securityAlert.update({
      where: { id },
      data: {
        status: 'resolved',
        resolvedBy,
        resolvedAt: new Date(),
        resolution,
      },
    });
  }

  // Log DM access
  async logDMAccess(data: {
    accessedBy: string;
    conversationId: string;
    participant1Id: string;
    participant2Id: string;
    reason: string;
    approvedBy?: string;
    ipAddress?: string;
    sessionId?: string;
  }) {
    const log = await prisma.dMAccessLog.create({ data });
    
    // Also create audit log
    await this.log({
      userId: data.accessedBy,
      category: 'DATA_ACCESS',
      action: 'dm_access',
      severity: 'CRITICAL',
      resource: 'dm',
      resourceId: data.conversationId,
      details: {
        participant1Id: data.participant1Id,
        participant2Id: data.participant2Id,
        reason: data.reason,
      },
      ipAddress: data.ipAddress,
    });

    logger.info({ logId: log.id, accessedBy: data.accessedBy }, 'DM access logged');
    return log;
  }

  // Get DM access logs
  async getDMAccessLogs(filters?: {
    accessedBy?: string;
    conversationId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    return prisma.dMAccessLog.findMany({
      where: {
        accessedBy: filters?.accessedBy,
        conversationId: filters?.conversationId,
        accessedAt: {
          gte: filters?.startDate,
          lte: filters?.endDate,
        },
      },
      orderBy: { accessedAt: 'desc' },
    });
  }

  // Generate compliance report
  async generateReport(type: string, periodStart: Date, periodEnd: Date, generatedBy: string) {
    // Get summary data based on type
    let summary: Record<string, unknown> = {};

    if (type === 'monthly_access') {
      const logs = await prisma.auditLog.groupBy({
        by: ['category'],
        where: {
          createdAt: { gte: periodStart, lte: periodEnd },
        },
        _count: true,
      });
      summary = { categories: logs };
    } else if (type === 'dm_audit') {
      const dmAccesses = await prisma.dMAccessLog.count({
        where: { accessedAt: { gte: periodStart, lte: periodEnd } },
      });
      summary = { totalDMAccesses: dmAccesses };
    }

    const report = await prisma.complianceReport.create({
      data: {
        type,
        periodStart,
        periodEnd,
        generatedBy,
        summary: summary as any,
      },
    });

    logger.info({ reportId: report.id, type }, 'Compliance report generated');
    return report;
  }

  // Get compliance reports
  async getReports(type?: string) {
    return prisma.complianceReport.findMany({
      where: type ? { type } : undefined,
      orderBy: { generatedAt: 'desc' },
    });
  }
}

export const auditService = new AuditService();
