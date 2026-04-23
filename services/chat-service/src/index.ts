// services/chat-service/src/index.ts
// Chat Service entry point

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { messageRoutes } from './routes/message.routes.js';
import { threadRoutes } from './routes/thread.routes.js';
import { mentionRoutes } from './routes/mention.routes.js';
import { readReceiptRoutes } from './routes/readreceipt.routes.js';
import { internalAuthMiddleware } from '@ott/shared';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { connectNats, disconnectNats } from './lib/nats.js';
import { startFileSubscriber } from './subscribers/file.subscriber.js';
import { startReadReceiptSubscriber } from './subscribers/readreceipt.subscriber.js';

const app = express();
const PORT = process.env.PORT || 3013;

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
      service: 'chat-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'chat-service',
      database: 'disconnected',
    });
  }
});

// Routes
// app.use(internalAuthMiddleware);
app.use('/messages', messageRoutes);
app.use('/threads', threadRoutes);
app.use('/mentions', mentionRoutes);
app.use('/chats', readReceiptRoutes);

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down chat-service...');
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

    // Start subscribers
    startFileSubscriber();
    startReadReceiptSubscriber();

    app.listen(PORT, () => {
      logger.info(`Chat Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start chat-service');
    process.exit(1);
  }
}

start();
