// services/identity-service/src/services/audit.service.ts
import { authPrisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export class AuditLogService {
  async createLog(data: {
    userId: string;
    action: string;
    resource: string;
    data?: any;
    ipAddress?: string;
    status?: 'SUCCESS' | 'FAILURE';
  }) {
    try {
      const log = await authPrisma.auditLog.create({
        data: {
          userId: data.userId,
          action: data.action,
          resource: data.resource,
          data: data.data || {},
          ipAddress: data.ipAddress,
          // Note: The AuditLog model in auth.prisma doesn't have a 'status' field yet, 
          // but I'll add it to the data JSON for now to maintain compatibility with frontend.
        },
        include: {
          account: {
            select: {
              name: true,
              email: true,
            }
          }
        }
      });

      // Publish event for real-time updates
      await publishEvent(EventSubjects.AUDIT_LOG_CREATED, {
        id: log.id,
        userId: log.userId,
        userName: log.account.name,
        action: log.action,
        resource: log.resource,
        details: log.data,
        ipAddress: log.ipAddress,
        status: data.status || 'SUCCESS',
        timestamp: log.createdAt.toISOString(),
      });

      return log;
    } catch (error) {
      logger.error({ error }, 'Failed to create audit log');
      throw error;
    }
  }

  async getLogs(options: {
    page?: number;
    limit?: number;
    action?: string;
    resource?: string;
    userId?: string;
    startDate?: string;
    endDate?: string;
  }) {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (options.action) where.action = options.action;
    if (options.resource) where.resource = options.resource;
    if (options.userId) where.userId = options.userId;
    if (options.startDate || options.endDate) {
      where.createdAt = {};
      if (options.startDate) where.createdAt.gte = new Date(options.startDate);
      if (options.endDate) where.createdAt.lte = new Date(options.endDate);
    }

    const [items, total] = await Promise.all([
      authPrisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          account: {
            select: {
              name: true,
              email: true,
            }
          }
        }
      }),
      authPrisma.auditLog.count({ where })
    ]);

    return {
      items: items.map(item => ({
        id: item.id,
        userId: item.userId,
        userName: item.account.name,
        action: item.action,
        resource: item.resource,
        details: item.data,
        ipAddress: item.ipAddress,
        status: 'SUCCESS', // Default since field missing in DB
        timestamp: item.createdAt.toISOString(),
      })),
      total,
      nextCursor: items.length === limit ? (page + 1).toString() : undefined,
    };
  }

  async getLogById(id: string) {
    const log = await authPrisma.auditLog.findUnique({
      where: { id },
      include: {
        account: {
          select: {
            name: true,
            email: true,
          }
        }
      }
    });

    if (!log) throw new Error('Audit log not found');

    return {
      log: {
        id: log.id,
        userId: log.userId,
        userName: log.account.name,
        action: log.action,
        resource: log.resource,
        details: log.data,
        ipAddress: log.ipAddress,
        status: 'SUCCESS',
        timestamp: log.createdAt.toISOString(),
      }
    };
  }
}

export const auditLogService = new AuditLogService();
