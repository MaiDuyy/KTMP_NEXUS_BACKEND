// services/userorg-service/src/services/user.service.ts
// Migrate từ user.controller.ts và account.controller.ts

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';


type AccountRole = 'EMPLOYEE' | 'SUPER_ADMIN' | 'WORKSPACE_MANAGER';

export class UserService {
  /**
   * Lấy profile của user
   */
  async getProfile(userId: string) {
    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        number: true,
        avatar: true,
        status: true,
        birthDate: true,
        location: true,
        gender: true,
        role: true,
        isVerified: true,
        isOnline: true,
        lastSeen: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    return user;
  }

  /**
   * Cập nhật profile
   */
  async updateProfile(
    userId: string,
    data: {
      name?: string;
      avatar?: string;
      status?: string;
      birthDate?: string;
      location?: string;
      gender?: string;
    }
  ) {
    const updateData: any = { updatedAt: new Date() };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.avatar !== undefined) updateData.avatar = data.avatar;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.birthDate !== undefined) {
      updateData.birthDate = data.birthDate ? new Date(data.birthDate) : null;
    }
    if (data.location !== undefined) updateData.location = data.location;
    if (data.gender !== undefined) updateData.gender = data.gender;

    const updatedUser = await prisma.account.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        number: true,
        avatar: true,
        status: true,
        birthDate: true,
        location: true,
        gender: true,
        role: true,
        isVerified: true,
      },
    });

    // Publish event
    await publishEvent(EventSubjects.USER_UPDATED, {
      id: userId,
      changes: Object.keys(data),
      updatedAt: new Date().toISOString(),
    });

    return updatedUser;
  }

  /**
   * Lấy thông tin chi tiết tài khoản
   */
  async getAccountDetails(userId: string) {
    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        number: true,
        avatar: true,
        status: true,
        birthDate: true,
        location: true,
        gender: true,
        role: true,
        isVerified: true,
        isOnline: true,
        lastSeen: true,
        createdAt: true,
        updatedAt: true,
        currentAvatars: true,
        pushToken: true,
      },
    });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    // Parse currentAvatars
    let avatarHistory: string[] = [];
    try {
      avatarHistory = user.currentAvatars ? JSON.parse(user.currentAvatars) : [];
    } catch {
      avatarHistory = [];
    }

    return {
      ...user,
      currentAvatars: avatarHistory,
    };
  }

  /**
   * Cập nhật thông tin tài khoản
   */
  async updateAccount(
    userId: string,
    data: {
      name?: string;
      birthDate?: string;
      location?: string;
      gender?: string;
      pushToken?: string;
    }
  ) {
    const updateData: any = { updatedAt: new Date() };

    if (data.name !== undefined) {
      if (!data.name || data.name.trim().length < 2) {
        throw new Error('Tên phải có ít nhất 2 ký tự!');
      }
      updateData.name = data.name.trim();
    }

    if (data.birthDate !== undefined) {
      updateData.birthDate = data.birthDate ? new Date(data.birthDate) : null;
    }

    if (data.location !== undefined) {
      updateData.location = data.location || null;
    }

    if (data.gender !== undefined) {
      const validGenders = ['male', 'female', 'other'];
      if (!validGenders.includes(data.gender.toLowerCase())) {
        throw new Error('Giới tính không hợp lệ!');
      }
      updateData.gender = data.gender.toLowerCase();
    }

    if (data.pushToken !== undefined) {
      updateData.pushToken = data.pushToken || null;
    }

    const updatedUser = await prisma.account.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        number: true,
        avatar: true,
        status: true,
        birthDate: true,
        location: true,
        gender: true,
        role: true,
        isVerified: true,
      },
    });

    return updatedUser;
  }

  /**
   * Cập nhật trạng thái (status text)
   */
  async updateStatus(userId: string, status: string | null) {
    if (status && status.length > 150) {
      throw new Error('Trạng thái không được quá 150 ký tự!');
    }

    await prisma.account.update({
      where: { id: userId },
      data: {
        status: status || null,
        updatedAt: new Date(),
      },
    });

    return { status: status || null };
  }

  /**
   * Cập nhật trạng thái online
   */
  async updateOnlineStatus(userId: string, isOnline: boolean) {
    await prisma.account.update({
      where: { id: userId },
      data: {
        isOnline,
        lastSeen: new Date(),
        updatedAt: new Date(),
      },
    });

    // Publish event
    const eventSubject = isOnline ? EventSubjects.USER_ONLINE : EventSubjects.USER_OFFLINE;
    await publishEvent(eventSubject, {
      userId,
      timestamp: new Date().toISOString(),
    });

    return { isOnline, lastSeen: new Date() };
  }

  /**
   * Heartbeat
   */
  async heartbeat(userId: string) {
    await prisma.account.update({
      where: { id: userId },
      data: {
        isOnline: true,
        lastSeen: new Date(),
      },
    });
  }

  /**
   * Lấy trạng thái hoạt động của user khác
   */
  async getUserActivityStatus(targetUserId: string) {
    const user = await prisma.account.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        avatar: true,
        status: true,
        isOnline: true,
        lastSeen: true,
      },
    });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    // Tính thời gian offline
    let lastSeenText = '';
    if (!user.isOnline && user.lastSeen) {
      const now = new Date();
      const lastSeen = new Date(user.lastSeen);
      const diffMs = now.getTime() - lastSeen.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffMins < 1) {
        lastSeenText = 'Vừa mới online';
      } else if (diffMins < 60) {
        lastSeenText = `${diffMins} phút trước`;
      } else if (diffHours < 24) {
        lastSeenText = `${diffHours} giờ trước`;
      } else {
        lastSeenText = `${diffDays} ngày trước`;
      }
    }

    return { ...user, lastSeenText };
  }

  // ============= ADMIN FUNCTIONS =============

  /**
   * Lấy danh sách tất cả users (Admin)
   */
  async getAllUsers(options: {
    page?: number;
    limit?: number;
    search?: string;
    role?: AccountRole;
  }) {
    const { page = 1, limit = 10, search, role } = options;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { number: { contains: search } },
      ];
    }

    if (role) {
      where.role = role;
    }

    const [users, total] = await Promise.all([
      prisma.account.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          number: true,
          avatar: true,
          status: true,
          gender: true,
          role: true,
          isVerified: true,
          isOnline: true,
          lastSeen: true,
          createdAt: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.account.count({ where }),
    ]);

    return {
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }


  
  /**
   * Tìm kiếm danh bạ chung (Enterprise Directory)
   */
 async searchDirectory(
  query: string,
  currentUserId: string,
  limit: number = 20
) {
  function normalize(str: string) {
    return str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function scoreUser(user: any, query: string) {
    const q = normalize(query);
    const name = normalize(user.name || "");
    const email = normalize(user.email || "");

    let score = 0;

    if (name === q) score += 100;
    if (name.startsWith(q)) score += 60;
    if (name.split(" ").some((w) => w.startsWith(q))) score += 50;
    if (name.includes(q)) score += 30;
    if (email.includes(q)) score += 10;
    // if (user.isOnline) score += 5;

    return score;
  }

  const where: any = {
    isAnonymized: false,
    id: { not: currentUserId },
    role: { not: "SUPER_ADMIN" },
  };

  if (query?.trim()) {
    where.OR = [
      { name: { contains: query, mode: "insensitive" } },
      { email: { contains: query, mode: "insensitive" } },
    ];
  }

  // ❗ LẤY RỘNG RA TRƯỚC
  const users = await prisma.account.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      avatar: true,
      status: true,
      userStatus: true,
      isOnline: true,
      customStatus: true,
    },
    take: 100, // 🔥 quan trọng
  });

  // 🧠 ranking
  const ranked = users
    .map((u) => ({
      ...u,
      _score: scoreUser(u, query),
    }))
    .sort((a, b) => b._score - a._score);

  // ✅ TRẢ KẾT QUẢ ĐÃ SORT
  return ranked.slice(0, limit);
}
  /**
   * Lấy user theo ID
   */
  async getUserById(userId: string) {
    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        number: true,
        avatar: true,
        status: true,
        birthDate: true,
        location: true,
        gender: true,
        role: true,
        isVerified: true,
        isOnline: true,
        lastSeen: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    return user;
  }

  /**
   * Lấy nhiều user theo IDs
   */
  async getUsersByIds(userIds: string[]) {
    return prisma.account.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        avatar: true,
        isOnline: true,
        userStatus: true,
        status: true,
      },
    });
  }

  /**
   * Cập nhật role của user (Admin)
   */
  async updateUserRole(userId: string, role: AccountRole) {
    const validRoles: AccountRole[] = ['EMPLOYEE', 'SUPER_ADMIN', 'WORKSPACE_MANAGER'];
    if (!validRoles.includes(role)) {
      throw new Error('Role không hợp lệ!');
    }

    const updatedUser = await prisma.account.update({
      where: { id: userId },
      data: { role },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    logger.info({ userId, role }, 'User role updated');

    return updatedUser;
  }

  /**
   * Xóa user (Admin)
   */
  async deleteUser(userId: string, currentUserId: string) {
    if (userId === currentUserId) {
      throw new Error('Không thể xóa tài khoản của chính mình!');
    }

    await prisma.account.delete({ where: { id: userId } });

    logger.info({ userId }, 'User deleted');
  }

  /**
   * Lấy danh sách thiết bị đăng nhập
   */
  async getLoggedInDevices(userId: string) {
    return prisma.loggedInDevice.findMany({
      where: { userId },
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        platform: true,
        ipAddress: true,
        lastActive: true,
        createdAt: true,
      },
      orderBy: { lastActive: 'desc' },
    });
  }

  /**
   * Đăng xuất thiết bị
   */
  async logoutDevice(userId: string, deviceId: string) {
    await prisma.loggedInDevice.deleteMany({
      where: { userId, deviceId },
    });
  }

  // ============= USER-03: Enhanced Status =============

  /**
   * Update user status (ONLINE/AWAY/DND/INVISIBLE)
   */
  async updateUserStatus(userId: string, userStatus: 'ONLINE' | 'AWAY' | 'DND' | 'INVISIBLE') {
    const validStatuses = ['ONLINE', 'AWAY', 'DND', 'INVISIBLE'];
    if (!validStatuses.includes(userStatus)) {
      throw new Error('Trạng thái không hợp lệ!');
    }

    const user = await prisma.account.update({
      where: { id: userId },
      data: {
        userStatus,
        // Also update isOnline based on status
        isOnline: userStatus !== 'INVISIBLE',
        lastSeen: new Date(),
      },
      select: {
        id: true,
        userStatus: true,
        isOnline: true,
        customStatus: true,
        customStatusEmoji: true,
      },
    });

    // Publish status change event
    await publishEvent(EventSubjects.USER_STATUS_CHANGED || 'user.status.changed', {
      userId,
      userStatus,
      customStatus: user.customStatus,
      customStatusEmoji: user.customStatusEmoji,
      timestamp: new Date().toISOString(),
    });

    return user;
  }

  // ============= USER-04: Custom Status =============

  /**
   * Set custom status with optional expiry
   */
  async setCustomStatus(
    userId: string,
    data: {
      text: string | null;
      emoji?: string | null;
      expiryHours?: number;
    }
  ) {
    const { text, emoji, expiryHours } = data;

    // Validate text length
    if (text && text.length > 100) {
      throw new Error('Custom status không được quá 100 ký tự!');
    }

    // Calculate expiry time
    let customStatusExpiry: Date | null = null;
    if (text && expiryHours && expiryHours > 0) {
      customStatusExpiry = new Date();
      customStatusExpiry.setHours(customStatusExpiry.getHours() + expiryHours);
    }

    const user = await prisma.account.update({
      where: { id: userId },
      data: {
        customStatus: text || null,
        customStatusEmoji: emoji ?? null,
        customStatusExpiry,
      },
      select: {
        id: true,
        customStatus: true,
        customStatusEmoji: true,
        customStatusExpiry: true,
        userStatus: true,
      },
    });

    // Publish event
    await publishEvent(EventSubjects.USER_STATUS_CHANGED || 'user.status.changed', {
      userId,
      userStatus: user.userStatus,
      customStatus: user.customStatus,
      customStatusEmoji: user.customStatusEmoji,
      customStatusExpiry: user.customStatusExpiry?.toISOString(),
      timestamp: new Date().toISOString(),
    });

    return user;
  }

  /**
   * Clear expired custom statuses (called by cron job)
   */
  async clearExpiredCustomStatuses(): Promise<number> {
    const result = await prisma.account.updateMany({
      where: {
        customStatusExpiry: {
          lte: new Date(),
        },
        customStatus: {
          not: null,
        },
      },
      data: {
        customStatus: null,
        customStatusEmoji: null,
        customStatusExpiry: null,
      },
    });

    if (result.count > 0) {
      logger.info({ count: result.count }, 'Cleared expired custom statuses');
    }

    return result.count;
  }

  // ============= USER-09: Enhanced Deletion / Anonymization =============

  /**
   * Delete user with anonymization option (GDPR compliance)
   */
  async deleteUserEnhanced(
    userId: string,
    currentUserId: string,
    options: { anonymize?: boolean } = {}
  ) {
    if (userId === currentUserId) {
      throw new Error('Không thể xóa tài khoản của chính mình!');
    }

    const user = await prisma.account.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });

    if (!user) {
      throw new Error('Không tìm thấy tài khoản!');
    }

    if (options.anonymize) {
      // Anonymize user data instead of hard delete
      return this.anonymizeUser(userId, currentUserId);
    }

    // Hard delete
    await prisma.account.delete({ where: { id: userId } });

    logger.info({ userId, deletedBy: currentUserId }, 'User hard deleted');

    // Publish event
    await publishEvent(EventSubjects.USER_DELETED || 'user.deleted', {
      userId,
      deletedBy: currentUserId,
      method: 'hard_delete',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Anonymize user data (GDPR compliant)
   * Keeps messages but removes PII
   */
  async anonymizeUser(userId: string, anonymizedBy: string) {
    const anonymizedAt = new Date();
    const anonymousId = `deleted_${userId.slice(0, 8)}`;

    await prisma.account.update({
      where: { id: userId },
      data: {
        // Replace PII with anonymous data
        name: 'Deleted User',
        email: `${anonymousId}@deleted.local`,
        password: 'ANONYMIZED',
        avatar: null,
        status: null,
        customStatus: null,
        customStatusEmoji: null,
        birthDate: null,
        location: null,
        pushToken: null,
        currentAvatars: null,
        
        // Set flags
        isAnonymized: true,
        anonymizedAt,
        isSuspended: true,
        suspendedAt: anonymizedAt,
        suspendedBy: anonymizedBy,
        suspendReason: 'Account anonymized',
        
        // Clear online status
        isOnline: false,
        userStatus: 'INVISIBLE',
      },
    });

    // Delete all logged in devices
    await prisma.loggedInDevice.deleteMany({
      where: { userId },
    });

    logger.info({ userId, anonymizedBy }, 'User anonymized');

    // Publish event
    await publishEvent(EventSubjects.USER_ANONYMIZED || 'user.anonymized', {
      userId,
      anonymizedBy,
      timestamp: anonymizedAt.toISOString(),
    });

    return { userId, anonymizedAt, anonymizedBy };
  }
}

export const userService = new UserService();
