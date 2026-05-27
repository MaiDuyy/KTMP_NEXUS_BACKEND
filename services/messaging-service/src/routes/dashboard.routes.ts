import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { taskService } from '../services/task.service.js';

export const dashboardRoutes = Router();

// ==========================================
// THÔNG TIN BẢNG DASHBOARD
// ==========================================

// Lấy danh sách nhiệm vụ của user
dashboardRoutes.get('/tasks', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

  const rawTasks = await prisma.task.findMany({
    where: {
      assignees: {
        some: {
          accountId: userId,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 15,
  });

  const tasks = rawTasks.map((t) => ({
    id: t.id,
    title: t.title,
    completed: t.status === 'DONE',
    priority: t.deadlineAt ? 'high' : 'medium',
  }));

  res.json(tasks);
}));

// Update trạng thái task
dashboardRoutes.patch('/tasks/:taskId', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const taskId = req.params.taskId as string;
  const { completed } = req.body;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

  const task = await taskService.updateTaskStatus(taskId, userId, completed ? 'DONE' : 'TODO');

  res.json({ success: true, task });
}));

// Lấy tệp chia sẻ gần đây của user
dashboardRoutes.get('/recent-files', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

  // Tìm các cuộc trò chuyện mà user tham gia
  const userParticipants = await prisma.chatParticipant.findMany({
    where: { accountId: userId },
    select: { chatId: true }
  });
  
  const chatIds = userParticipants.map(p => p.chatId);

  const recentMediaMessages = await prisma.message.findMany({
    where: {
      type: {
        in: ['FILE', 'IMAGE', 'VIDEO', 'AUDIO'],
      },
      chatId: {
        in: chatIds
      }
    },
    orderBy: {
      time: 'desc', // Field is 'time', not 'createdAt'
    },
    take: 10,
  });

  const results = recentMediaMessages.map((msg) => {
    let ext = msg.type;
    if (msg.fileName) {
      ext = msg.fileName.split('.').pop()?.toUpperCase() || msg.type;
    }
    if (ext.length > 5) ext = 'FILE';
    if (msg.type === 'IMAGE') ext = 'IMAGE';

    return {
      id: msg.id,
      name: msg.fileName || 'Tệp đính kèm',
      type: ext,
      url: msg.content || '', // content stores the url for media types
      time: msg.time,
    };
  });

  res.json(results);
}));

// Lấy thống kê hệ thống cho Admin
dashboardRoutes.get('/admin/stats', asyncHandler(async (_req: Request, res: Response) => {
  const [totalMessages, totalChats, totalTasks, activeTasks, totalWorkspaces, pendingInvitations] = await Promise.all([
    prisma.message.count(),
    prisma.chat.count(),
    prisma.task.count(),
    prisma.task.count({ where: { status: { not: 'DONE' } } }),
    prisma.workspace.count(),
    prisma.workspaceInvite.count({ where: { status: 'PENDING' } }),
  ]);

  // Lấy biểu đồ tin nhắn trong 7 ngày qua
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const messageActivityRaw = await prisma.message.findMany({
    where: { time: { gte: sevenDaysAgo } },
    select: { time: true },
  });

  const activityMap = new Map<string, number>();
  messageActivityRaw.forEach(m => {
    const date = new Date(m.time).toISOString().split('T')[0];
    activityMap.set(date, (activityMap.get(date) || 0) + 1);
  });

  const messageActivity = Array.from(activityMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    success: true,
    totalMessages,
    totalChats,
    totalTasks,
    activeTasks,
    totalWorkspaces,
    pendingInvitations,
    messageActivity,
  });
}));
