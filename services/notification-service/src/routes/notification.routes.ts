// services/notification-service/src/routes/notification.routes.ts

import { Router } from 'express';
import { notificationService } from '../services/notification.service.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Get notifications for user
router.get('/notifications/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { isRead, type, limit, offset } = req.query;

    const notifications = await notificationService.getByUser({
      userId,
      isRead: isRead !== undefined ? isRead === 'true' : undefined,
      type: type as any,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });

    const unreadCount = await notificationService.getUnreadCount(userId);

    res.json({ 
      notifications, 
      unreadCount 
    });
  } catch (error) {
    logger.error(error, 'Failed to get notifications');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get unread count
router.get('/notifications/:userId/unread-count', async (req, res) => {
  try {
    const { userId } = req.params;
    const unreadCount = await notificationService.getUnreadCount(userId);
    res.json({ unreadCount });
  } catch (error) {
    logger.error(error, 'Failed to get unread count');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark notification as read
router.patch('/notifications/:notificationId/read', async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.body?.userId || req.headers["x-user-id"];

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const success = await notificationService.markAsRead(notificationId, userId);
    
    if (!success) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(error, 'Failed to mark notification as read');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark all notifications as read
router.patch('/notifications/:userId/read-all', async (req, res) => {
  try {
    const { userId } = req.params;
    const count = await notificationService.markAllAsRead(userId);
    res.json({ success: true, count });
  } catch (error) {
    logger.error(error, 'Failed to mark all notifications as read');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete notification
router.delete('/notifications/:notificationId', async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.body?.userId || req.headers["x-user-id"];

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const success = await notificationService.delete(notificationId, userId);
    
    if (!success) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(error, 'Failed to delete notification');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete all notifications for user
router.delete('/notifications/:userId/all', async (req, res) => {
  try {
    const { userId } = req.params;
    const count = await notificationService.deleteAll(userId);
    res.json({ success: true, count });
  } catch (error) {
    logger.error(error, 'Failed to delete all notifications');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register push token
router.post('/push-tokens', async (req, res) => {
  try {
    const { userId, token, platform, deviceId } = req.body;

    if (!userId || !token || !platform) {
      return res.status(400).json({ error: 'userId, token, and platform are required' });
    }

    const pushToken = await notificationService.registerPushToken(userId, token, platform, deviceId);
    res.status(201).json({ data: pushToken });
  } catch (error) {
    logger.error(error, 'Failed to register push token');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove push token
router.delete('/push-tokens/:token', async (req, res) => {
  try {
    const { token } = req.params;
    await notificationService.removePushToken(token);
    res.json({ success: true });
  } catch (error) {
    logger.error(error, 'Failed to remove push token');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const notificationRoutes = router;
