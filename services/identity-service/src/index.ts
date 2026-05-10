// services/identity-service/src/index.ts
// Unified Identity Service — consolidates auth + userorg + rbac

import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { authRoutes } from './routes/auth.routes.js';
import { userRoutes } from './routes/user.routes.js';
import { friendRoutes } from './routes/friend.routes.js';
import { invitationRoutes } from './routes/invitation.routes.js';
import { orgSettingsRoutes } from './routes/org-settings.routes.js';
import { rbacRoutes } from './routes/rbac.routes.js';
import { orgRoutes } from './routes/org.routes.js';
import { workspaceRoutes } from './routes/workspace.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { auditRoutes } from './routes/audit.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { authPrisma, userorgPrisma, rbacPrisma } from './lib/prisma.js';
import { connectNats, disconnectNats } from './lib/nats.js';
import { startGrpcServer } from './grpc-server.js';
import { startAvatarSubscriber } from './subscribers/file.subscriber.js';
import { startInvitationSubscriber } from './subscribers/invitation.subscriber.js';
import { startWorkspaceSubscriber } from './subscribers/workspace.subscriber.js';
import { startCronJobs } from './lib/cron-jobs.js';

const app = express();
const PORT = process.env.PORT || 3010;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());

// Health check — pings all 3 schemas
app.get('/healthz', async (_req, res) => {
  try {
    await Promise.all([
      authPrisma.$queryRaw`SELECT 1`,
      userorgPrisma.$queryRaw`SELECT 1`,
      rbacPrisma.$queryRaw`SELECT 1`,
    ]);
    res.json({
      status: 'ok',
      service: 'identity-service',
      databases: { auth: 'connected', userorg: 'connected', rbac: 'connected' },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'error',
      service: 'identity-service',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// ============= MOUNT ROUTES =============
// Auth routes — /auth/* (backward compatible with old auth-service)
app.use('/', authRoutes);

// User routes — /users/* (backward compatible with old userorg-service)
app.use('/users', userRoutes);

// Friend routes — /friends/*
app.use('/friends', friendRoutes);

// Invitation routes — /invitations/*
app.use('/invitations', invitationRoutes);

// Org settings routes — /org-settings/*
app.use('/org-settings', orgSettingsRoutes);

// RBAC routes — /rbac/* (backward compatible with old rbac-service at root)
app.use('/', rbacRoutes);

// Org (departments + groups) routes — /org/*
app.use('/', orgRoutes);

// Admin routes — /admin/*
app.use('/admin', adminRoutes);

// Workspace routes — /workspaces/*
app.use('/workspaces', workspaceRoutes);

// Audit routes — /audit/*
app.use('/audit', auditRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route không tồn tại!' });
});

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down identity-service...');
  await disconnectNats();
  await Promise.all([
    authPrisma.$disconnect(),
    userorgPrisma.$disconnect(),
    rbacPrisma.$disconnect(),
  ]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    await connectNats()
      .then(() => {
        startAvatarSubscriber();
        startInvitationSubscriber();
        startWorkspaceSubscriber();
      })
      .catch((e) => {
        logger.warn({ error: e.message }, 'NATS not available — running without events');
      });

    startGrpcServer();
    startCronJobs();

    app.listen(PORT, () => {
      logger.info(`🚀 Identity Service running on port  ${PORT}`);
      logger.info(`   Consolidates: auth-service + userorg-service + rbac-service`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start identity-service');
    process.exit(1);
  }
}

start();
