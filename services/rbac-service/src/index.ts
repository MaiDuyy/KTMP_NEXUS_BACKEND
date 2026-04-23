import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rbacRoutes } from './routes/rbac.routes.js';
import { orgRoutes } from './routes/org.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { internalAuthMiddleware } from '@ott/shared';
import { connectNats, disconnectNats } from './lib/nats.js';

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
      service: 'rbac-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'rbac-service',
      database: 'disconnected',
    });
  }
});

// Routes
// app.use(internalAuthMiddleware);
app.use('/', rbacRoutes);
app.use('/', orgRoutes);

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down rbac-service...');
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
    await connectNats().catch((e) => {
      logger.warn({ error: e.message }, 'NATS not available');
    });

    app.listen(PORT, () => {
      logger.info(`RBAC Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start rbac-service');
    process.exit(1);
  }
}

start();
