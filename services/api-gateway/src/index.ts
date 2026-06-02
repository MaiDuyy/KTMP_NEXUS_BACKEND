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

app.set('trust proxy', 2);
app.use((req, res, next) => {
  (req as any).startTime = Date.now();
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Gateway] Incoming: ${req.method} ${req.url}`);
  }
  next();
});

app.use(helmet());

const originsFromEnv = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : [];
const allowedOrigins = ['http://localhost:3002', 'http://127.0.0.1:3002', ...originsFromEnv];
if (process.env.NODE_ENV !== 'production') {
  console.log("=== KIỂM TRA ALLOWED ORIGINS ===", allowedOrigins);
}
app.use((req, res, next) => {
  // Handle Private Network Access preflight requests
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'X-Workspace-Id', 'Access-Control-Allow-Private-Network'],
}));



app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) {
        return 'error';
      }
      if (res.statusCode >= 400) {
        return 'warn';
      }
      
      if (process.env.NODE_ENV === 'production') {
        const startTime = (req as any).startTime || Date.now();
        const duration = Date.now() - startTime;
        if (duration > 1000) {
          return 'warn';
        }
        return 'silent';
      }
      
      return 'info';
    },
    autoLogging: {
      ignore: (req) => {
        const ignoredPaths = ['/healthz', '/metrics', '/health'];
        return ignoredPaths.includes(req.url || '');
      },
    },
  })
);

app.use('/', healthRoutes);

app.use('/demo', demoRoutes);

app.use(rateLimiter);

// Strict rate limiting for sensitive auth endpoints (5 req / 15 min)
app.use(['/api/auth/signin', '/auth/signin'], strictRateLimiter);
app.use(['/api/auth/signup', '/auth/signup'], strictRateLimiter);
app.use(['/api/auth/signin-phone', '/auth/signin-phone'], strictRateLimiter);
app.use(['/api/auth/verify-otp', '/auth/verify-otp'], strictRateLimiter);
app.use(['/api/auth/resend-otp', '/auth/resend-otp'], strictRateLimiter);
app.use(['/api/auth/register-organization', '/auth/register-organization'], strictRateLimiter);
app.use(['/api/otp', '/otp'], strictRateLimiter);

import { workspaceMiddleware } from './middleware/workspace.js';

// Gateway auth: public paths bypass, protected paths enforce JWT
app.use(['/api', '/'], gatewayAuthMiddleware, workspaceMiddleware, proxyRoutes);

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

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '[Gateway] Unhandled Rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal(error, '[Gateway] Uncaught Exception');
  process.exit(1);
});

start();

export default app;
