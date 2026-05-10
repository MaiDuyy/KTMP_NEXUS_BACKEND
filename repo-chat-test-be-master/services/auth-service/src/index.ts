// services/auth-service/src/index.ts
// Auth Service entry point

import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { authRoutes } from './routes/auth.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { internalAuthMiddleware } from '@ott/shared';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { connectNats, disconnectNats } from './lib/nats.js';
import { startAvatarSubscriber } from './subscribers/file.subscriber.js';

const app = express();
const PORT = process.env.PORT || 3010;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());

// Health check
app.get('/healthz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      service: 'auth-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'auth-service',
      database: 'disconnected',
    });
  }
});

// Routes
// app.use(internalAuthMiddleware);
app.use('/', authRoutes);

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down auth-service...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    // Connect to NATS (optional)
    await connectNats()
     .then(() => {
        startAvatarSubscriber();
      })
    .catch((e) => {
      logger.warn({ error: e.message }, 'NATS not available');
    });

    app.listen(PORT, () => {
      logger.info(`Auth Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start auth-service');
    process.exit(1);
  }
}

start();
