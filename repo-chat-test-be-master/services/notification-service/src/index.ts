// services/notification-service/src/index.ts
// Notification Service entry point

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { notificationRoutes } from './routes/notification.routes.js';
import { otpRoutes } from './routes/otp.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { internalAuthMiddleware } from '@ott/shared';
import { connectNats, disconnectNats } from './lib/nats.js';
import { setupSubscribers } from './subscribers/notification.subscriber.js';
import { setupOtpSubscriber } from './subscribers/otp.subscriber.js';

const app = express();
const PORT = process.env.PORT || 3015;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/healthz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      service: 'notification-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'notification-service',
      database: 'disconnected',
    });
  }
});

// ============= STATISTICS =============
app.get('/stats', async (_req, res) => {
  try {
    const [totalNotifications, unreadNotifications, typeDistribution] = await Promise.all([
      prisma.notification.count(),
      prisma.notification.count({ where: { isRead: false } }),
      prisma.notification.groupBy({
        by: ['type'],
        _count: { _all: true }
      })
    ]);

    res.json({
      success: true,
      totalNotifications,
      unreadNotifications,
      typeDistribution: typeDistribution.map(t => ({ type: t.type, count: t._count._all })),
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Notification stats error');
    res.status(500).json({ success: false, message: 'Lỗi lấy thống kê thông báo!' });
  }
});

// Routes
// app.use(internalAuthMiddleware);
app.use('/', notificationRoutes);
app.use('/otp', otpRoutes);

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down notification-service...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    // Connect to NATS
    await connectNats().catch((e) => {
      logger.warn({ error: e.message }, 'NATS not available');
    });

    // Setup event subscribers
    setupSubscribers();
    setupOtpSubscriber();

    app.listen(PORT, () => {
      logger.info(`Notification Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start notification-service');
    process.exit(1);
  }
}

start();
