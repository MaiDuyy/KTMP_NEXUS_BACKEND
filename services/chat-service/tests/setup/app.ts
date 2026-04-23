// tests/setup/app.ts
// Test Express app setup without starting server

import express from 'express';
import { messageRoutes } from '../../src/routes/message.routes.js';
import { threadRoutes } from '../../src/routes/thread.routes.js';
import { mentionRoutes } from '../../src/routes/mention.routes.js';
import { readReceiptRoutes } from '../../src/routes/readreceipt.routes.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

export function createTestApp() {
  const app = express();
  app.use(express.json());

  // Routes
  app.use('/messages', messageRoutes);
  app.use('/threads', threadRoutes);
  app.use('/mentions', mentionRoutes);
  app.use('/chats', readReceiptRoutes);

  // Error handler
  app.use(errorHandler);

  return app;
}
