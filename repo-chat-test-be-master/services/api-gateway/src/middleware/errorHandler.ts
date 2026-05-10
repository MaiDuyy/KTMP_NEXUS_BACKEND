import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: Record<string, string[]>;
}

/**
 * Global error handler middleware
 */
export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  // Log error
  logger.error({
    err,
    method: req.method,
    path: req.path,
    correlationId: req.correlationId,
    userId: req.user?.id,
  }, 'Request error');

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    err.errors.forEach((e) => {
      const path = e.path.join('.');
      if (!details[path]) {
        details[path] = [];
      }
      details[path].push(e.message);
    });

    return res.status(400).json({
      success: false,
      error: 'Validation error',
      code: 'VALIDATION_ERROR',
      details,
    });
  }

  // Handle known errors with status codes
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code || 'ERROR',
      details: err.details,
    });
  }

  // Handle specific error types
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: 'Invalid token',
      code: 'INVALID_TOKEN',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: 'Token expired',
      code: 'TOKEN_EXPIRED',
    });
  }

  // Handle proxy errors
  if (err.message?.includes('ECONNREFUSED')) {
    return res.status(503).json({
      success: false,
      error: 'Service temporarily unavailable',
      code: 'SERVICE_UNAVAILABLE',
    });
  }

  // Default 500 error
  const isProduction = process.env.NODE_ENV === 'production';
  
  res.status(500).json({
    success: false,
    error: isProduction ? 'Internal server error' : err.message,
    code: 'INTERNAL_ERROR',
    ...(isProduction ? {} : { stack: err.stack }),
  });
}

/**
 * Create an error with status code
 */
export function createError(
  message: string,
  statusCode: number = 500,
  code?: string,
  details?: Record<string, string[]>
): AppError {
  const error: AppError = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

/**
 * Async handler wrapper to catch errors in async route handlers
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Not found handler
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`,
    code: 'NOT_FOUND',
  });
}
