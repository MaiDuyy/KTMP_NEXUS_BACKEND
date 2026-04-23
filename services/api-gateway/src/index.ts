// API Gateway - Main Entry Point
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { gatewayAuthMiddleware } from './middleware/auth.js';
import { rateLimiter, strictRateLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { proxyRoutes } from './routes/proxy.js';
import { demoRoutes } from './routes/demo.js';
import { logger } from './lib/logger.js';
import { connectNats, disconnectNats } from './lib/nats.js';
import { connectRedis, disconnectRedis } from './lib/redis.js';
import cookieParser from 'cookie-parser';
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(helmet());

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3002',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID'],
}));


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/healthz',
    },
  })
);

app.use('/', healthRoutes);

app.use('/demo', demoRoutes);

app.use(rateLimiter);

// Strict rate limiting for sensitive auth endpoints (5 req / 15 min)
app.use('/api/auth/signin', strictRateLimiter);
app.use('/api/auth/signup', strictRateLimiter);
app.use('/api/auth/signin-phone', strictRateLimiter);
app.use('/api/auth/verify-otp', strictRateLimiter);
app.use('/api/auth/resend-otp', strictRateLimiter);
app.use('/api/otp', strictRateLimiter);

// Gateway auth: public paths bypass, protected paths enforce JWT
app.use('/api', gatewayAuthMiddleware, proxyRoutes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

app.use(errorHandler);

async function shutdown() {
  logger.info('Shutting down gracefully...');
  
  await disconnectNats();
  await disconnectRedis();
  
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function start() {
  try {
    await connectRedis();
    await connectNats();
    
    app.listen(PORT, () => {
      logger.info(`🚀 API Gateway running on port ${PORT}`);
      logger.info(`📚 Health check: http://localhost:${PORT}/healthz`);
      logger.info(`🧪 Demo endpoints: http://localhost:${PORT}/demo`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start API Gateway');
    process.exit(1);
  }
}

start();

export default app;
