// services/identity-service/src/middleware/errorHandler.ts

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { ZodError } from 'zod';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ error: err.message, stack: err.stack }, 'Error occurred');

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: 'Dữ liệu yêu cầu không hợp lệ',
      errors: err.errors
    });
    return;
  }

  if (err.message.includes('không tìm thấy') || err.message.includes('Không tìm thấy')) {
    res.status(404).json({ success: false, message: err.message });
    return;
  }

  if (err.message.includes('không đúng') || err.message.includes('không hợp lệ') ||
      err.message.includes('hết hạn') || err.message.includes('chưa được') ||
      err.message.includes('không an toàn')) {
    res.status(401).json({ success: false, message: err.message });
    return;
  }

  if (err.message.includes('không có quyền') || err.message.includes('chỉ') ||
      err.message.includes('bị đình chỉ') || err.message.includes('giới hạn') ||
      err.message.includes('đã đạt')) {
    res.status(403).json({ success: false, message: err.message });
    return;
  }

  if (err.message.includes('đã được sử dụng') || err.message.includes('đã có') ||
      err.message.includes('đã tồn tại') || err.message.includes('bạn bè') ||
      err.message.includes('đã chặn')) {
    res.status(409).json({ success: false, message: err.message });
    return;
  }

  if (err.message.includes('Thiếu') || err.message.includes('không thể') ||
      err.message.includes('Không thể')) {
    res.status(400).json({ success: false, message: err.message });
    return;
  }

  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'development' ? err.message : 'Lỗi server!',
  });
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
