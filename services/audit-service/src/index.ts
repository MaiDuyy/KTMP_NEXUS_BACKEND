// services/audit-service/src/index.ts
// Audit Service entry point

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { auditRoutes } from './routes/audit.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { internalAuthMiddleware } from '@ott/shared';
import { connectNats, disconnectNats, subscribeToEvents, AuditEventSubjects } from './lib/nats.js';
import { auditService } from './services/audit.service.js';

const app = express();
const PORT = process.env.PORT || 3017;

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
      service: 'audit-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'audit-service',
      database: 'disconnected',
    });
  }
});

// Routes
// app.use(internalAuthMiddleware);
app.use('/', auditRoutes);

// Error handler
app.use(errorHandler);

// Handle incoming events from NATS
async function handleEvent(subject: string, data: unknown): Promise<void> {
  const eventData = data as Record<string, unknown>;
  
  // Map event subjects to audit categories
  const categoryMap: Record<string, string> = {
    'auth.': 'AUTH',
    'rbac.': 'ROLE_MGMT',
    'knowledge.': 'DATA_ACCESS',
    'chat.': 'DATA_ACCESS',
  };

  let category = 'SYSTEM';
  for (const [prefix, cat] of Object.entries(categoryMap)) {
    if (subject.startsWith(prefix)) {
      category = cat;
      break;
    }
  }

  // Extract action from subject
  const action = subject.split('.').slice(-1)[0];
  const resource = subject.split('.').slice(0, -1).join('.');

  await auditService.log({
    userId: eventData.userId as string,
    category: category as any,
    action,
    resource,
    resourceId: (eventData.id || eventData.documentId || eventData.roleId) as string,
    details: eventData,
  });
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down audit-service...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    // Connect to NATS and subscribe to events
    await connectNats().then(() => {
      subscribeToEvents(AuditEventSubjects, handleEvent);
    }).catch((e) => {
      logger.warn({ error: e.message }, 'NATS not available, running without event subscription');
    });

    app.listen(PORT, () => {
      logger.info(`Audit Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start audit-service');
    process.exit(1);
  }
}

start();
