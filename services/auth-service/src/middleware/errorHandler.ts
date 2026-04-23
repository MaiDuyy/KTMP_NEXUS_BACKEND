// services/auth-service/src/middleware/errorHandler.ts

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ error: err.message, stack: err.stack }, 'Error occurred');

  // Xử lý các loại lỗi cụ thể
  if (err.message.includes('không tìm thấy') || err.message.includes('Không tìm thấy')) {
    res.status(404).json({ success: false, message: err.message });
    return;
  }

  if (err.message.includes('không đúng') || err.message.includes('không hợp lệ') ||
      err.message.includes('hết hạn') || err.message.includes('chưa được')) {
    res.status(401).json({ success: false, message: err.message });
    return;
  }

  if (err.message.includes('không có quyền') || err.message.includes('chỉ')) {
    res.status(403).json({ success: false, message: err.message });
    return;
  }

  if (err.message.includes('đã được sử dụng') || err.message.includes('đã có')) {
    res.status(409).json({ success: false, message: err.message });
    return;
  }

  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'development' ? err.message : 'Lỗi server!',
  });
}

// Async handler wrapper
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
