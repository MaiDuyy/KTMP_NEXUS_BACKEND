// services/userorg-service/src/index.ts

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { userRoutes } from './routes/user.routes.js';
import { invitationRoutes } from './routes/invitation.routes.js';
import { orgSettingsRoutes } from './routes/org-settings.routes.js';
import { friendRoutes } from './routes/friend.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { internalAuthMiddleware } from '@ott/shared';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { connectNats, disconnectNats, subscribeToAuthEvents } from './lib/nats.js';
import { startAvatarSubscriber } from './subscribers/file.subscriber.js';

const app = express();
const PORT = process.env.PORT || 3011;

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
      service: 'userorg-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'userorg-service',
      database: 'disconnected',
    });
  }
});

// Routes
// app.use(internalAuthMiddleware);
app.use('/users', userRoutes);
app.use('/invitations', invitationRoutes);
app.use('/org-settings', orgSettingsRoutes);
app.use('/friends', friendRoutes);

// Admin Stats endpoint
app.get('/admin/stats', async (req, res) => {
  try {
    // Get user counts
    const [totalUsers, activeUsers] = await Promise.all([
      prisma.account.count(),
      prisma.account.count({ where: { isOnline: true } }),
    ]);
    
    // Get pending invitations count (if Invitation table exists)
    let pendingInvitations = 0;
    try {
      pendingInvitations = await (prisma as any).invitation?.count({
        where: { status: 'pending' }
      }) || 0;
    } catch { /* Invitation table may not exist */ }
    
    // Get role distribution
    const roleDistribution = await prisma.account.groupBy({
      by: ['role'],
      _count: { role: true },
    }).then(results => results.map(r => ({
      role: r.role || 'EMPLOYEE',
      count: r._count.role
    })));
    
    // Placeholder department distribution (no department field yet)
    const departmentDistribution: Array<{ department: string; count: number }> = [];
    
    // Placeholder recent activity
    const recentActivity: Array<{ type: string; description: string; timestamp: string }> = [];

    res.json({
      success: true,
      totalUsers,
      activeUsers,
      pendingInvitations,
      roleDistribution,
      departmentDistribution,
      recentActivity,
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to get admin stats');
    res.status(500).json({ success: false, message: 'Failed to get stats' });
  }
});

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down userorg-service...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    await connectNats()
      .then(() => {
        // Subscribe to auth-service events for user sync
        subscribeToAuthEvents();
        startAvatarSubscriber();
      })
      .catch((e) => {
        logger.warn({ error: e.message }, 'NATS not available, user sync disabled');
      });

    app.listen(PORT, () => {
      logger.info(`UserOrg Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start userorg-service');
    process.exit(1);
  }
}

start();
