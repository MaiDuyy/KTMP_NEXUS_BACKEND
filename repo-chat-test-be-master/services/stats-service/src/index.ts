// services/stats-service/src/index.ts
// Stats Service - Thống kê và analytics

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { internalAuthMiddleware } from '@ott/shared';
import { connectNats, disconnectNats, subscribeEvent, EventSubjects } from './lib/nats.js';

const app = express();
const PORT = process.env.PORT || 3015;

// In-memory stats (có thể thay bằng Redis)
const stats = {
  totalUsers: 0,
  onlineUsers: 0,
  totalMessages: 0,
  totalGroups: 0,
  messagesPerDay: new Map<string, number>(),
};

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

// ============= HEALTH CHECK =============

app.get('/healthz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      service: 'stats-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ status: 'error', service: 'stats-service', database: 'disconnected' });
  }
});

// ============= GET OVERALL STATS =============
app.use(internalAuthMiddleware);

app.get('/', async (_req, res) => {
  try {
    // Get stats from database
    const [userCount, groupCount, messageCount, onlineCount] = await Promise.all([
      prisma.stat.findFirst({ where: { key: 'total_users' } }),
      prisma.stat.findFirst({ where: { key: 'total_groups' } }),
      prisma.stat.findFirst({ where: { key: 'total_messages' } }),
      prisma.stat.findFirst({ where: { key: 'online_users' } }),
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers: userCount?.value || stats.totalUsers,
        onlineUsers: onlineCount?.value || stats.onlineUsers,
        totalMessages: messageCount?.value || stats.totalMessages,
        totalGroups: groupCount?.value || stats.totalGroups,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Get stats error');
    res.status(500).json({ success: false, message: 'Lỗi lấy thống kê!' });
  }
});

// ============= GET USER STATS =============

app.get('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const userStats = await prisma.userStat.findUnique({
      where: { userId },
    });

    if (!userStats) {
      return res.json({
        success: true,
        stats: {
          userId,
          messagesSent: 0,
          messagesReceived: 0,
          friendsCount: 0,
          groupsCount: 0,
        },
      });
    }

    res.json({
      success: true,
      stats: userStats,
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Get user stats error');
    res.status(500).json({ success: false, message: 'Lỗi lấy thống kê user!' });
  }
});

// ============= GET CHAT STATS =============

app.get('/chats/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;

    const chatStats = await prisma.chatStat.findUnique({
      where: { chatId },
    });

    if (!chatStats) {
      return res.json({
        success: true,
        stats: {
          chatId,
          messageCount: 0,
          memberCount: 0,
          mediaCount: 0,
        },
      });
    }

    res.json({
      success: true,
      stats: chatStats,
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Get chat stats error');
    res.status(500).json({ success: false, message: 'Lỗi lấy thống kê chat!' });
  }
});

// ============= GET DAILY STATS =============

app.get('/daily', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const daysCount = Math.min(parseInt(days as string), 30);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysCount);

    const dailyStats = await prisma.dailyStat.findMany({
      where: {
        date: { gte: startDate },
      },
      orderBy: { date: 'asc' },
    });

    res.json({
      success: true,
      dailyStats: dailyStats.map((d) => ({
        date: d.date.toISOString().split('T')[0],
        newUsers: d.newUsers,
        activeUsers: d.activeUsers,
        messages: d.messages,
      })),
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Get daily stats error');
    res.status(500).json({ success: false, message: 'Lỗi lấy thống kê theo ngày!' });
  }
});

// ============= NATS EVENT HANDLERS =============

function setupEventHandlers() {
  // User created
  subscribeEvent(EventSubjects.USER_CREATED, async (event) => {
    stats.totalUsers++;
    await updateStat('total_users', 1);
    await updateDailyStat('newUsers', 1);
    logger.debug('User created event processed');
  });

  // User online
  subscribeEvent(EventSubjects.USER_ONLINE, async (event) => {
    stats.onlineUsers++;
    await updateStat('online_users', 1);
  });

  // User offline
  subscribeEvent(EventSubjects.USER_OFFLINE, async (event) => {
    stats.onlineUsers = Math.max(0, stats.onlineUsers - 1);
    await updateStat('online_users', -1);
  });

  // Message created
  subscribeEvent(EventSubjects.MESSAGE_CREATED, async (event) => {
    stats.totalMessages++;
    await updateStat('total_messages', 1);
    await updateDailyStat('messages', 1);

    // Update user message count
    const payload = event.payload as any;
    if (payload.senderId) {
      await updateUserStat(payload.senderId, 'messagesSent', 1);
    }
    if (payload.chatId) {
      await updateChatStat(payload.chatId, 'messageCount', 1);
    }
  });

  // Group created
  subscribeEvent(EventSubjects.GROUP_CREATED, async (event) => {
    stats.totalGroups++;
    await updateStat('total_groups', 1);
  });

  logger.info('NATS event handlers registered');
}

// ============= STAT UPDATE HELPERS =============

async function updateStat(key: string, delta: number) {
  try {
    await prisma.stat.upsert({
      where: { key },
      update: { value: { increment: delta }, updatedAt: new Date() },
      create: { key, value: delta },
    });
  } catch (error) {
    logger.error({ error, key }, 'Failed to update stat');
  }
}

async function updateDailyStat(field: 'newUsers' | 'activeUsers' | 'messages', delta: number) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.dailyStat.upsert({
      where: { date: today },
      update: { [field]: { increment: delta } },
      create: { date: today, [field]: delta },
    });
  } catch (error) {
    logger.error({ error, field }, 'Failed to update daily stat');
  }
}

async function updateUserStat(userId: string, field: string, delta: number) {
  try {
    await prisma.userStat.upsert({
      where: { userId },
      update: { [field]: { increment: delta }, updatedAt: new Date() },
      create: { userId, [field]: delta },
    });
  } catch (error) {
    logger.error({ error, userId, field }, 'Failed to update user stat');
  }
}

async function updateChatStat(chatId: string, field: string, delta: number) {
  try {
    await prisma.chatStat.upsert({
      where: { chatId },
      update: { [field]: { increment: delta }, updatedAt: new Date() },
      create: { chatId, [field]: delta },
    });
  } catch (error) {
    logger.error({ error, chatId, field }, 'Failed to update chat stat');
  }
}

// ============= GRACEFUL SHUTDOWN =============

async function shutdown() {
  logger.info('Shutting down stats-service...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ============= START =============

async function start() {
  try {
    await connectNats().catch((e) => logger.warn({ error: e.message }, 'NATS not available'));
    
    // Setup event handlers
    setupEventHandlers();

    app.listen(PORT, () => {
      logger.info(`Stats Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start stats-service');
    process.exit(1);
  }
}

start();
