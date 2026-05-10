// services/knowledge-service/src/index.ts
// Knowledge Service entry point

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { knowledgeRoutes } from './routes/knowledge.routes.js';
import { ragRoutes } from './routes/rag.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { internalAuthMiddleware } from '@ott/shared';
import { connectNats, disconnectNats } from './lib/nats.js';
import { processingService } from './services/processing.service.js';
import { startAISubscriber } from './subscribers/ai.subscriber.js';

const app = express();
const PORT = process.env.PORT || 3016;

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
      service: 'knowledge-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'error',
      service: 'knowledge-service',
      database: 'disconnected',
    });
  }
});

// Routes
app.use(internalAuthMiddleware);
app.use('/', knowledgeRoutes);
app.use('/rag', ragRoutes);

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down knowledge-service...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Background processing (every 30 seconds)
let processingInterval: NodeJS.Timeout | null = null;

function startBackgroundProcessing() {
  processingInterval = setInterval(async () => {
    try {
      await processingService.processPendingDocuments();
    } catch (error) {
      logger.error(error, 'Background processing failed');
    }
  }, 30000); // 30 seconds
}

// Start server
async function start() {
  try {
    // Connect to NATS (optional)
    await connectNats().catch((e) => {
      logger.warn({ error: e.message }, 'NATS not available');
    });

    // Start background document processing
    startBackgroundProcessing();

    // Start AI request listener
    startAISubscriber();

    app.listen(PORT, () => {
      logger.info(`Knowledge Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start knowledge-service');
    process.exit(1);
  }
}

start();
