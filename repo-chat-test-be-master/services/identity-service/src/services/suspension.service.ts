// services/identity-service/src/services/suspension.service.ts
// Migrated from userorg-service — prisma → userorgPrisma

import { userorgPrisma, authPrisma } from '../lib/prisma.js';
import { publishEvent } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export interface SuspensionResult {
  userId: string; isSuspended: boolean;
  suspendedAt?: Date; suspendedBy?: string; suspendReason?: string;
}

export class SuspensionService {
  async suspendUser(userId: string, data: { reason: string; suspendedBy: string; }): Promise<SuspensionResult> {
    const { reason, suspendedBy } = data;
    if (!reason || reason.trim().length < 5) throw new Error('Lý do đình chỉ phải có ít nhất 5 ký tự!');

    const user = await userorgPrisma.account.findUnique({
      where: { id: userId }, select: { id: true, name: true, email: true, isSuspended: true },
    });
    if (!user) throw new Error('Không tìm thấy tài khoản!');
    if (user.isSuspended) throw new Error('Tài khoản đã bị đình chỉ trước đó!');
    if (userId === suspendedBy) throw new Error('Không thể đình chỉ tài khoản của chính mình!');

    const suspendedAt = new Date();
    await userorgPrisma.account.update({
      where: { id: userId },
      data: { isSuspended: true, suspendedAt, suspendedBy, suspendReason: reason.trim(), isOnline: false, lastSeen: suspendedAt },
    });

    // ⚡ SYNC: Update auth schema for login enforcement
    await authPrisma.account.update({
      where: { id: userId },
      data: { isSuspended: true, isOnline: false, lastSeen: suspendedAt },
    }).catch(err => logger.error({ err, userId }, 'Failed to sync suspension to auth schema'));

    // Revoke all refresh tokens for the user immediately
    await authPrisma.refreshToken.updateMany({
      where: { userId, isRevoked: false },
      data: { isRevoked: true },
    }).catch(() => {});

    logger.info({ userId, suspendedBy, reason }, 'User suspended');
    await publishEvent('user.suspended', { userId, suspendedBy, reason: reason.trim(), timestamp: suspendedAt.toISOString() });

    return { userId, isSuspended: true, suspendedAt, suspendedBy, suspendReason: reason.trim() };
  }

  async unsuspendUser(userId: string, data: { reason: string; unsuspendedBy: string; }): Promise<SuspensionResult> {
    const { reason, unsuspendedBy } = data;
    if (!reason || reason.trim().length < 5) throw new Error('Lý do mở đình chỉ phải có ít nhất 5 ký tự!');

    const user = await userorgPrisma.account.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, isSuspended: true, suspendedAt: true, suspendedBy: true, suspendReason: true },
    });
    if (!user) throw new Error('Không tìm thấy tài khoản!');
    if (!user.isSuspended) throw new Error('Tài khoản không bị đình chỉ!');

    await userorgPrisma.account.update({
      where: { id: userId },
      data: { isSuspended: false, suspendedAt: null, suspendedBy: null, suspendReason: null },
    });

    // ⚡ SYNC: Update auth schema to allow login
    await authPrisma.account.update({
      where: { id: userId },
      data: { isSuspended: false },
    }).catch(err => logger.error({ err, userId }, 'Failed to sync unsuspension to auth schema'));

    // 📜 AUDIT: Create audit log for unsuspension
    await authPrisma.auditLog.create({
      data: {
        userId: unsuspendedBy,
        action: 'UNSUSPEND_USER',
        resource: `account:${userId}`,
        data: {
          targetUserId: userId,
          reason: reason.trim(),
          previousSuspension: {
            suspendedAt: user.suspendedAt,
            suspendedBy: user.suspendedBy,
            suspendReason: user.suspendReason
          }
        }
      }
    }).catch(() => {});

    logger.info({ userId, unsuspendedBy, reason }, 'User unsuspended');
    await publishEvent('user.unsuspended', {
      userId, unsuspendedBy,
      reason: reason.trim(),
      previousSuspension: { suspendedAt: user.suspendedAt?.toISOString(), suspendedBy: user.suspendedBy, reason: user.suspendReason },
      timestamp: new Date().toISOString(),
    });
    return { userId, isSuspended: false };
  }

  async isSuspended(userId: string): Promise<boolean> {
    const user = await userorgPrisma.account.findUnique({ where: { id: userId }, select: { isSuspended: true } });
    return user?.isSuspended ?? false;
  }

  async getSuspensionDetails(userId: string): Promise<SuspensionResult | null> {
    const user = await userorgPrisma.account.findUnique({
      where: { id: userId },
      select: { id: true, isSuspended: true, suspendedAt: true, suspendedBy: true, suspendReason: true },
    });
    if (!user) return null;
    return {
      userId: user.id, isSuspended: user.isSuspended,
      suspendedAt: user.suspendedAt ?? undefined, suspendedBy: user.suspendedBy ?? undefined, suspendReason: user.suspendReason ?? undefined,
    };
  }

  async listSuspendedUsers(options: { page?: number; limit?: number; }) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      userorgPrisma.account.findMany({
        where: { isSuspended: true },
        select: { id: true, name: true, email: true, suspendedAt: true, suspendedBy: true, suspendReason: true },
        skip, take: limit, orderBy: { suspendedAt: 'desc' },
      }),
      userorgPrisma.account.count({ where: { isSuspended: true } }),
    ]);
    return { users, total };
  }
}

export const suspensionService = new SuspensionService();
