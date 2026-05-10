import { Router, type Request, type Response } from 'express';
import { demoRateLimiter } from '../middleware/rateLimit.js';
import { getRedisClient } from '../lib/redis.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';

export const demoRoutes = Router();

// ============= RUBRIC Demo Endpoints =============

/**
 * Demo: Rate Limiter Test
 * Endpoint returns 429 after 10 requests per minute
 * Used to demonstrate rate limiting for RUBRIC
 */
demoRoutes.get('/limited', demoRateLimiter, (_req, res) => {
  res.json({
    success: true,
    message: 'Rate limit demo - You still have requests remaining',
    hint: 'Try calling this endpoint more than 10 times in 1 minute to see rate limiting in action',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Demo: Unstable Endpoint
 * Randomly returns 503 for retry testing
 * ~30% chance of failure
 */
demoRoutes.get('/unstable', (_req, res) => {
  const shouldFail = Math.random() < 0.3;

  if (shouldFail) {
    logger.info('Demo unstable endpoint returning 503');
    res.status(503).json({
      success: false,
      error: 'Service temporarily unavailable (simulated failure)',
      code: 'DEMO_UNSTABLE',
      hint: 'This is intentional! Use retry logic (3-5s delay) on the client side.',
    });
    return;
  }

  res.json({
    success: true,
    message: 'Request succeeded!',
    hint: 'This endpoint randomly fails ~30% of the time for retry testing',
    timestamp: new Date().toISOString(),
  });
});

// ============= Redis CRUD Demo =============

const PROFILE_PREFIX = 'profile:';

/**
 * Demo: Redis CREATE - Store a profile
 */
demoRoutes.post(
  '/profiles/cache',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, data } = req.body as { userId?: string; data?: unknown };

    if (!userId || data == null) {
      res.status(400).json({
        success: false,
        error: 'userId and data are required',
      });
      return;
    }

    const redis = getRedisClient();
    const key = `${PROFILE_PREFIX}${userId}`;

    await redis.setex(key, 3600, JSON.stringify(data)); // 1 hour TTL

    logger.info({ userId }, 'Redis CRUD: Created profile');

    res.status(201).json({
      success: true,
      message: 'Profile cached successfully',
      key,
      ttl: 3600,
    });
  })
);

/**
 * Demo: Redis READ - Get a profile
 */
demoRoutes.get(
  '/profiles/cache/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const redis = getRedisClient();
    const key = `${PROFILE_PREFIX}${userId}`;

    const data = await redis.get(key);

    if (!data) {
      res.status(404).json({
        success: false,
        error: 'Profile not found in cache',
      });
      return;
    }

    const ttl = await redis.ttl(key);

    res.json({
      success: true,
      data: JSON.parse(data),
      ttl,
    });
  })
);

/**
 * Demo: Redis UPDATE - Update a profile
 */
demoRoutes.patch(
  '/profiles/cache/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { data } = req.body as { data?: Record<string, unknown> };

    if (data == null) {
      res.status(400).json({
        success: false,
        error: 'data is required',
      });
      return;
    }

    const redis = getRedisClient();
    const key = `${PROFILE_PREFIX}${userId}`;

    const existing = await redis.get(key);
    if (!existing) {
      res.status(404).json({
        success: false,
        error: 'Profile not found in cache',
      });
      return;
    }

    const merged = { ...JSON.parse(existing), ...data };
    const ttl = await redis.ttl(key);

    await redis.setex(key, ttl > 0 ? ttl : 3600, JSON.stringify(merged));

    logger.info({ userId }, 'Redis CRUD: Updated profile');

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: merged,
    });
  })
);

/**
 * Demo: Redis DELETE - Delete a profile
 */
demoRoutes.delete(
  '/profiles/cache/:userId',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const redis = getRedisClient();
    const key = `${PROFILE_PREFIX}${userId}`;

    const deleted = await redis.del(key);

    if (deleted === 0) {
      res.status(404).json({
        success: false,
        error: 'Profile not found in cache',
      });
      return;
    }

    logger.info({ userId }, 'Redis CRUD: Deleted profile');

    res.json({
      success: true,
      message: 'Profile deleted from cache',
    });
  })
);

/**
 * Demo: List all cached profiles (for testing)
 */
demoRoutes.get(
  '/profiles/cache',
  asyncHandler(async (_req: Request, res: Response) => {
    const redis = getRedisClient();
    const keys = await redis.keys(`${PROFILE_PREFIX}*`);

    const profiles = await Promise.all(
      keys.map(async (key) => {
        const data = await redis.get(key);
        const ttl = await redis.ttl(key);
        return {
          key,
          userId: key.replace(PROFILE_PREFIX, ''),
          data: data ? JSON.parse(data) : null,
          ttl,
        };
      })
    );

    res.json({
      success: true,
      count: profiles.length,
      profiles,
    });
  })
);

// ============= Demo Info =============

demoRoutes.get('/', (_req, res) => {
  res.json({
    message: 'Demo Endpoints for RUBRIC Testing',
    endpoints: {
      '/demo/limited': {
        method: 'GET',
        description: 'Rate limiter demo - 10 requests/minute limit',
      },
      '/demo/unstable': {
        method: 'GET',
        description: 'Unstable endpoint - ~30% failure rate for retry testing',
      },
      '/demo/profiles/cache': {
        POST: 'Create cached profile (body: { userId, data })',
        GET: 'List all cached profiles',
      },
      '/demo/profiles/cache/:userId': {
        GET: 'Get cached profile',
        PATCH: 'Update cached profile (body: { data })',
        DELETE: 'Delete cached profile',
      },
    },
  });
});
