import { Request, Response, NextFunction } from 'express';
import { getCache, setCache } from '../lib/redis.js';
import { messagingClient } from '../lib/messagingClient.js';
import { logger } from '../lib/logger.js';

/**
 * Middleware kiểm tra tư cách thành viên của User trong Workspace.
 * Hoạt động:
 * 1. Đọc X-Workspace-Id từ header.
 * 2. Kiểm tra Cache Redis để giảm tải gRPC.
 * 3. Nếu chưa có cache, gọi gRPC sang Messaging Service.
 * 4. Chặn 403 nếu User không thuộc Workspace.
 */
export async function workspaceMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'OPTIONS') {
    return next();
  }
  const workspaceId = req.headers['x-workspace-id'] as string;
  const userId = req.user?.id;

  // Nếu không có workspaceId, Gateway sẽ cho phép đi qua 
  // (Việc chặn các route bắt buộc có Workspace sẽ do Policy Map hoặc Downstream Service xử lý)
  if (!workspaceId || !userId) {
    return next();
  }

  const cacheKey = `ws_auth:${userId}:${workspaceId}`;
  
  try {
    // 1. Kiểm tra Cache
    const cachedAuth = await getCache<{ isMember: boolean; role: string }>(cacheKey);
    if (cachedAuth) {
      if (!cachedAuth.isMember) {
        return res.status(403).json({ 
          success: false, 
          error: 'Bạn không có quyền truy cập vào Workspace này!', 
          code: 'FORBIDDEN' 
        });
      }
      (req as any).workspaceRole = cachedAuth.role;
      return next();
    }

    // 2. Gọi gRPC Membership Challenge
    const result = await messagingClient.getMemberRole(userId, workspaceId);
    
    // 3. Lưu Cache (TTL 5 phút)
    await setCache(cacheKey, result, 300);

    if (!result.isMember) {
      return res.status(403).json({ 
        success: false, 
        error: 'Bạn không phải là thành viên của Workspace này!', 
        code: 'FORBIDDEN' 
      });
    }

    (req as any).workspaceRole = result.role;
    next();
  } catch (error) {
    logger.error({ error, userId, workspaceId }, 'Workspace auth middleware error');
    // Chặn truy cập nếu hệ thống xác thực gặp lỗi (Fail-closed)
    res.status(500).json({ success: false, error: 'Lỗi xác thực Workspace (gRPC Error)' });
  }
}
