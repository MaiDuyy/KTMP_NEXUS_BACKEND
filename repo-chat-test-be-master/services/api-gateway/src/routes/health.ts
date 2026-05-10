import { Router } from 'express';
import { getRedisClient } from '../lib/redis.js';
import { getNatsConnection } from '../lib/nats.js';

export const healthRoutes = Router();

healthRoutes.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
  });
});

healthRoutes.get('/ready', async (_req, res) => {
  const checks = {
    redis: false,
    nats: false,
  };

  try {
    const redis = getRedisClient();
    const pong = await redis.ping();
    checks.redis = pong === 'PONG';
  } catch {
    checks.redis = false;
  }

  try {
    const nats = getNatsConnection();
    checks.nats = !nats.isClosed();
  } catch {
    checks.nats = false;
  }

  const allHealthy = Object.values(checks).every(Boolean);

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    checks,
  });
});

healthRoutes.get('/version', (_req, res) => {
  res.json({
    service: 'api-gateway',
    version: process.env.npm_package_version || '1.0.0',
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'development',
  });
});


