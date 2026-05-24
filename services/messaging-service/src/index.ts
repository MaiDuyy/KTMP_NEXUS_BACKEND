// services/messaging-service/src/index.ts
// Unified Messaging Service — Entry Point
// Merges chat-service (PORT 3013) + group-service (PORT 3012) into a single service

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import { connectNats, disconnectNats } from './lib/nats.js';
import { prisma } from './lib/prisma.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startGrpcServer } from './grpc-server.js';

// Routes
import { messageRoutes } from './routes/message.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { workspaceRoutes } from './routes/workspace.routes.js';
import { channelRoutes } from './routes/channel.routes.js';

// Subscribers
import { startFileSubscriber } from './subscribers/file.subscriber.js';
import { startReadReceiptSubscriber } from './subscribers/readreceipt.subscriber.js';
import { startUserSubscriber } from './subscribers/user.subscriber.js';
import { startFriendSubscriber } from './subscribers/friend.subscriber.js';
import { startOrganizationSubscriber } from './subscribers/organization.subscriber.js';
import { startInvitationSubscriber } from './subscribers/invitation.subscriber.js';
import { startDepartmentSubscriber } from './subscribers/department.subscriber.js';

const app = express();
const PORT = process.env.PORT || 3020;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3002',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/healthz' },
  })
);

// Health check
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', service: 'messaging-service', timestamp: new Date().toISOString() });
});

// ============= ROUTES =============

// Message routes (from chat-service) — mounted at /messages
app.use('/messages', messageRoutes);

// Chat/Group routes (from group-service) — mounted at /chats
app.use('/chats', chatRoutes);

// Workspace routes (from group-service) — mounted at /workspaces
app.use('/workspaces', workspaceRoutes);

// Dashboard routes
import { dashboardRoutes } from './routes/dashboard.routes.js';
app.use('/dashboard', dashboardRoutes);

// Channel routes (from group-service) — includes /workspaces/:wsId/channels, /channels/:id, /categories/:id
app.use('/', channelRoutes);

// Error handler
app.use(errorHandler);

// 404
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down gracefully...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start
async function start() {
  try {
    // Connect to database
    // await prisma.$connect();
    // logger.info('Database connected');

    // Connect to NATS
    await connectNats();

    // Start NATS subscribers
    startFileSubscriber();
    await startReadReceiptSubscriber();
    startUserSubscriber();
    startFriendSubscriber();
    startOrganizationSubscriber();
    startInvitationSubscriber();
    startDepartmentSubscriber();
    logger.info('NATS subscribers started');

    // Start gRPC server
    startGrpcServer();

    app.listen(PORT, () => {
      logger.info(`🚀 Messaging Service running on port ${PORT}`);
      logger.info(`📚 Health check: http://localhost:${PORT}/healthz`);
      logger.info('📦 Unified service: chat-service + group-service');
    });
  } catch (error) {
    logger.error(error, 'Failed to start Messaging Service');
    process.exit(1);
  }
}

start();

export default app;
