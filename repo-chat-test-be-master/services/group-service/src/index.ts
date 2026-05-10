// services/group-service/src/index.ts
// Group Service entry point (extended with Workspace & Channel - Module 4)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { chatRoutes } from './routes/chat.routes.js';
import { workspaceRoutes } from './routes/workspace.routes.js';
import { channelRoutes } from './routes/channel.routes.js';
import { channelCategoryRoutes } from './routes/channel-category.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { internalAuthMiddleware } from '@ott/shared';
import { connectNats, disconnectNats } from './lib/nats.js';
// import { GroupServiceServer } from './grpc/server.js';

const app = express();
const PORT = process.env.PORT || 3012;
// const GRPC_PORT = process.env.GRPC_PORT || '50055';

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
      service: 'group-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'group-service',
      database: 'disconnected',
    });
  }
});

// Routes
// app.use(internalAuthMiddleware);
app.use('/chats', chatRoutes);
app.use('/workspaces', workspaceRoutes);
app.use('/', channelRoutes);          // Channel routes have mixed paths
app.use('/', channelCategoryRoutes);  // Category routes have mixed paths

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down group-service...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    await connectNats().catch((e) => {
      logger.warn({ error: e.message }, 'NATS not available');
    });

    // Start gRPC server
    // const grpcServer = new GroupServiceServer();
    // grpcServer.start(GRPC_PORT);
    // logger.info(`gRPC server started on port ${GRPC_PORT}`);

    app.listen(PORT, () => {
      logger.info(`Group Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start group-service');
    process.exit(1);
  }
}

start();
