// services/notification-service/src/services/notification.service.ts

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { getAllUserIds } from '../lib/grpc-client.js';
import type { NotificationType } from '@prisma/client';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
 data?: NotificationData;
}

export interface NotificationAction {
  type: 'NAVIGATE' | 'OPEN_MODAL' | 'API_CALL';
  label: string;
  url?: string;
}

export interface NotificationData {
  action?: NotificationAction;
  [key: string]: any;
}

export interface NotificationFilter {
  userId: string;
  isRead?: boolean;
  type?: NotificationType;
  limit?: number;
  offset?: number;
}

export const notificationService = {
  async create(input: CreateNotificationInput) {
    const notification = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data || {},
      },
    });
    
    // Publish event for real-time notification
    await publishEvent(EventSubjects.NOTIFICATION_CREATED, {
      id: notification.id,
      userId: notification.userId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      data: input.data, // use raw data object
      createdAt: notification.createdAt,
    });

    logger.info({ notificationId: notification.id, userId: input.userId }, 'Notification created');
    return notification;
  },

  async getByUser(filter: NotificationFilter) {
    const notifications = await prisma.notification.findMany({
      where: {
        userId: filter.userId,
        ...(filter.isRead !== undefined && { isRead: filter.isRead }),
        ...(filter.type && { type: filter.type }),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit || 50,
      skip: filter.offset || 0,
    });

    return notifications;
  },

  async markAsRead(notificationId: string, userId: string) {
    const notification = await prisma.notification.updateMany({
      where: {
        id: notificationId,
        userId: userId,
      },
      data: {
        isRead: true,
      },
    });

    return notification.count > 0;
  },

  async markAllAsRead(userId: string) {
    const result = await prisma.notification.updateMany({
      where: {
        userId: userId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    logger.info({ userId, count: result.count }, 'Marked all notifications as read');
    return result.count;
  },

  async delete(notificationId: string, userId: string) {
    const result = await prisma.notification.deleteMany({
      where: {
        id: notificationId,
        userId: userId,
      },
    });

    return result.count > 0;
  },

  async deleteAll(userId: string) {
    const result = await prisma.notification.deleteMany({
      where: {
        userId: userId,
      },
    });

    logger.info({ userId, count: result.count }, 'Deleted all notifications');
    return result.count;
  },

  async deleteByType(userId: string, type: NotificationType) {
    const result = await prisma.notification.deleteMany({
      where: { userId, type },
    });
    logger.info({ userId, type, count: result.count }, 'Deleted notifications by type');
    return result.count;
  },

  async deleteReadOnly(userId: string) {
    const result = await prisma.notification.deleteMany({
      where: { userId, isRead: true },
    });
    logger.info({ userId, count: result.count }, 'Deleted read notifications');
    return result.count;
  },

  async getUnreadCount(userId: string) {
    const count = await prisma.notification.count({
      where: {
        userId: userId,
        isRead: false,
      },
    });

    return count;
  },

  // Push token management
  async registerPushToken(userId: string, token: string, platform: string, deviceId?: string) {
    const pushToken = await prisma.pushToken.upsert({
      where: { token },
      update: {
        userId,
        platform,
        deviceId,
        updatedAt: new Date(),
      },
      create: {
        userId,
        token,
        platform,
        deviceId,
      },
    });

    logger.info({ userId, platform }, 'Push token registered');
    return pushToken;
  },

  async removePushToken(token: string) {
    await prisma.pushToken.deleteMany({
      where: { token },
    });
  },

  async getUserPushTokens(userId: string) {
    return prisma.pushToken.findMany({
      where: { userId },
    });
  },

  async broadcast(input: { title: string; body: string; type?: NotificationType; data?: any }) {
    try {
      // Fetch ALL users from identity-service via gRPC
      const userIds = await getAllUserIds();

      if (userIds.length === 0) {
        logger.warn('No users found for broadcast');
        return 0;
      }

      // Save notifications for all users using the standard create method
      // This ensures individual events are fired for each user
      for (const uid of userIds) {
        // Validate type against NotificationType enum
        const validTypes = ['FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'NEW_MESSAGE', 'GROUP_INVITE', 'GROUP_REMOVED', 'WORKSPACE_INVITE', 'MENTION', 'REACTION', 'SYSTEM', 'ANNOUNCEMENT'];
        const notificationType = validTypes.includes(input.type as string) ? input.type : 'SYSTEM';

        await this.create({
          userId: uid,
          type: (notificationType as any),
          title: input.title,
          body: input.body,
          data: input.data || {},
        });
      }

      // NOTE: We do NOT re-publish SYSTEM_BROADCAST here to avoid an infinite loop
      // since this method is triggered by that same event.
      // The ws-gateway already listens to the original event from identity-service.

      logger.info({ count: userIds.length, title: input.title }, 'System-wide broadcast persisted to database');
      return userIds.length;
    } catch (error) {
      logger.error({ error }, 'Failed to process broadcast');
      throw error;
    }
  }
};
