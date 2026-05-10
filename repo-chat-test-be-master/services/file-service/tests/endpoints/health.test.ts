// tests/endpoints/health.test.ts
// Health check endpoint tests

import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockPrisma } from '../setup.js';

// Create minimal test app
function createTestApp() {
  const app = express();
  app.use(express.json());

  app.get('/healthz', async (_req, res) => {
    try {
      await mockPrisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        service: 'file-service',
        database: 'connected',
        storageProvider: 'mock',
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ status: 'error', service: 'file-service', database: 'disconnected' });
    }
  });

  return app;
}

describe('Health Check Endpoint', () => {
  const app = createTestApp();

  describe('GET /healthz', () => {
    it('should return ok status when database is connected', async () => {
      // Arrange
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ 1: 1 }]);

      // Act
      const response = await request(app).get('/healthz');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('file-service');
      expect(response.body.database).toBe('connected');
      expect(response.body.storageProvider).toBe('mock');
      expect(response.body.timestamp).toBeDefined();
    });

    it('should return error status when database is disconnected', async () => {
      // Arrange
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('Connection failed'));

      // Act
      const response = await request(app).get('/healthz');

      // Assert
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('error');
      expect(response.body.database).toBe('disconnected');
    });
  });
});
