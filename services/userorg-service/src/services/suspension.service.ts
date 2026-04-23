// services/userorg-service/src/services/suspension.service.ts
// USER-08: User Suspension

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export interface SuspensionResult {
  userId: string;
  isSuspended: boolean;
  suspendedAt?: Date;
  suspendedBy?: string;
  suspendReason?: string;
}

export class SuspensionService {
  /**
   * Suspend a user account (USER-08)
   * Prevents user from logging in until unsuspended
   */
  async suspendUser(
    userId: string,
    data: {
      reason: string;
      suspendedBy: string;
    }
  ): Promise<SuspensionResult> {
    const { reason, suspendedBy } = data;

    // Validate reason
    if (!reason || reason.trim().length < 5) {
      throw new Error('Lý do đình chỉ phải có ít nhất 5 ký tự!');
    }

    // Check if user exists
    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, isSuspended: true },
    });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    if (user.isSuspended) {
      throw new Error('Tài khoản đã bị đình chỉ trước đó!');
    }

    // Prevent self-suspension
    if (userId === suspendedBy) {
      throw new Error('Không thể đình chỉ tài khoản của chính mình!');
    }

    const suspendedAt = new Date();

    await prisma.account.update({
      where: { id: userId },
      data: {
        isSuspended: true,
        suspendedAt,
        suspendedBy,
        suspendReason: reason.trim(),
        // Also set offline status
        isOnline: false,
        lastSeen: suspendedAt,
      },
    });

    logger.info({ userId, suspendedBy, reason }, 'User suspended');

    // Publish event for other services (auth-service, ws-gateway)
    await publishEvent(EventSubjects.USER_SUSPENDED || 'user.suspended', {
      userId,
      suspendedBy,
      reason: reason.trim(),
      timestamp: suspendedAt.toISOString(),
    });

    // TODO: Publish audit event
    // await publishAuditEvent('USER_SUSPENDED', { userId, suspendedBy, reason });

    return {
      userId,
      isSuspended: true,
      suspendedAt,
      suspendedBy,
      suspendReason: reason.trim(),
    };
  }

  /**
   * Unsuspend a user account
   */
  async unsuspendUser(
    userId: string,
    unsuspendedBy: string
  ): Promise<SuspensionResult> {
    // Check if user exists and is suspended
    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        isSuspended: true,
        suspendedAt: true,
        suspendedBy: true,
        suspendReason: true,
      },
    });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    if (!user.isSuspended) {
      throw new Error('Tài khoản không bị đình chỉ!');
    }

    await prisma.account.update({
      where: { id: userId },
      data: {
        isSuspended: false,
        suspendedAt: null,
        suspendedBy: null,
        suspendReason: null,
      },
    });

    logger.info({ userId, unsuspendedBy }, 'User unsuspended');

    // Publish event
    await publishEvent(EventSubjects.USER_UNSUSPENDED || 'user.unsuspended', {
      userId,
      unsuspendedBy,
      previousSuspension: {
        suspendedAt: user.suspendedAt?.toISOString(),
        suspendedBy: user.suspendedBy,
        reason: user.suspendReason,
      },
      timestamp: new Date().toISOString(),
    });

    return {
      userId,
      isSuspended: false,
    };
  }

  /**
   * Check if a user is suspended
   */
  async isSuspended(userId: string): Promise<boolean> {
    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: { isSuspended: true },
    });

    return user?.isSuspended ?? false;
  }

  /**
   * Get suspension details
   */
  async getSuspensionDetails(userId: string): Promise<SuspensionResult | null> {
    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isSuspended: true,
        suspendedAt: true,
        suspendedBy: true,
        suspendReason: true,
      },
    });

    if (!user) {
      return null;
    }

    return {
      userId: user.id,
      isSuspended: user.isSuspended,
      suspendedAt: user.suspendedAt ?? undefined,
      suspendedBy: user.suspendedBy ?? undefined,
      suspendReason: user.suspendReason ?? undefined,
    };
  }

  /**
   * List all suspended users (Admin)
   */
  async listSuspendedUsers(options: {
    page?: number;
    limit?: number;
  }): Promise<{
    users: Array<{
      id: string;
      name: string;
      email: string;
      suspendedAt: Date | null;
      suspendedBy: string | null;
      suspendReason: string | null;
    }>;
    total: number;
  }> {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      prisma.account.findMany({
        where: { isSuspended: true },
        select: {
          id: true,
          name: true,
          email: true,
          suspendedAt: true,
          suspendedBy: true,
          suspendReason: true,
        },
        skip,
        take: limit,
        orderBy: { suspendedAt: 'desc' },
      }),
      prisma.account.count({ where: { isSuspended: true } }),
    ]);

    return { users, total };
  }
}

export const suspensionService = new SuspensionService();
