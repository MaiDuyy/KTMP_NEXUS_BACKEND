import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { getRedisClient } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

declare module 'express' {
  interface Request {
    rateLimit?: {
      limit: number;
      current: number;
      remaining: number;
      resetTime?: Date;
    };
  }
}

/**
 * Trích xuất địa chỉ IP thực tế của client từ chuỗi proxy X-Forwarded-For
 */
const getClientIp = (req: any): string => {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ip = typeof xForwardedFor === 'string' ? xForwardedFor.split(',')[0] : xForwardedFor[0];
    if (ip) return ip.trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

/**
 * Cấu hình giới hạn request mặc định (Default rate limiter)
 * Quy định: 1000 requests mỗi 15 phút cho một địa chỉ IP
 */
export const rateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '1000', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests, please try again later',
    code: 'RATE_LIMITED',
  },
  skip: (req) => {
    if (req.path === '/healthz' || req.path === '/ready') return true;
    
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      return true;
    }
    
    return false;
  },
  keyGenerator: getClientIp,
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Rate limit exceeded');
    const resetTime = (req as any).rateLimit?.resetTime;
    res.status(429).json({
      success: false,
      error: 'Too many requests, please try again later',
      code: 'RATE_LIMITED',
      retryAfter: resetTime ? Math.ceil((resetTime.getTime() - Date.now()) / 1000) : 60,
    });
  },
});

/**
 * Cấu hình khắt khe (Strict rate limiter) dành riêng cho các API nhạy cảm (như Auth, gửi mã OTP)
 * Quy định: Chỉ được gọi 5 requests mỗi 15 phút
 */
export const strictRateLimiter = rateLimit({
  windowMs: parseInt(process.env.STRICT_RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.STRICT_RATE_LIMIT_MAX || '15', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many attempts, please try again later',
    code: 'RATE_LIMITED',
  },
    skip: (req) => {
    
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      return true;
    }
    
    return false;
  },
  keyGenerator: getClientIp,
});

/**
 * Cấu hình dùng để trình diễn/thử nghiệm (Demo rate limiter)
 * Quy định: 10 requests mỗi 1 phút - Rất dễ để kích hoạt chặn nhằm mục đích test luồng lỗi
 */
export const demoRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1p
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Rate limit exceeded! This is a demo endpoint.',
    code: 'DEMO_RATE_LIMITED',
    hint: 'Wait 1 minute or use a different IP',
  },
  keyGenerator: getClientIp,
});
/**
 * Hàm khởi tạo Rate Limiter kết nối với Redis (Dùng cho Production)
 * Cực kỳ quan trọng khi chạy API Gateway ở nhiều container/máy chủ khác nhau. 
 * Redis giúp đồng bộ bộ đếm request giữa tất cả các máy chủ, tránh việc bị bypass.
 */
export function createRedisRateLimiter(windowMs: number, max: number) {
  try {
    const redisClient = getRedisClient();
    
    return rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      store: new RedisStore({
        // @ts-expect-error - Type mismatch in library
        sendCommand: (...args: string[]) => redisClient.call(...args),
      }),
      message: {
        success: false,
        error: 'Too many requests',
        code: 'RATE_LIMITED',
      },
      keyGenerator: getClientIp,
    });
  } catch (error) {
    logger.warn('Redis not available, using memory store for rate limiting');
    return rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: getClientIp,
    });
  }
}
