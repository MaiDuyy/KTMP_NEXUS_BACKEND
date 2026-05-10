// services/userorg-service/src/routes/friend.routes.ts

import { Router } from 'express';
import type { Request, Response } from 'express';
import { friendService } from '../services/friend.service.js';
import { userService } from '../services/user.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { internalAuthMiddleware } from '@ott/shared';

export const friendRoutes = Router();

// ============= FRIENDSHIP ROUTES =============

/**
 * GET /friends - Lấy danh sách bạn bè
 */
friendRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const search = req.query.search as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    const friends = await friendService.getFriends(userId, search);
    res.json({ success: true, friends });
}));

/**
 * DELETE /friends/:friendId - Hủy kết bạn
 */
friendRoutes.delete('/:friendId', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const friendId = req.params.friendId as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    await friendService.unfriend(userId, friendId);
    res.json({ success: true, message: 'Đã hủy kết bạn!' });
}));

/**
 * GET /friends/search - Tìm kiếm người dùng để kết bạn
 */
friendRoutes.get('/search', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const q = req.query.q as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    if (!q || q.length < 2) {
        return res.json({ success: true, users: [] });
    }

    // Sử dụng searchDirectory từ userService
    const users = await userService.searchDirectory(q, userId);

    // Bổ sung thông tin quan hệ (relation status) cho từng user
    const friends = await friendService.getFriends(userId);
    const sentReqs = await friendService.getSentRequests(userId);
    const recvReqs = await friendService.getReceivedRequests(userId);

    const friendIds = new Set(friends.map(f => f.id));
    const sentIds = new Map(sentReqs.map(r => [r.receiverId, r.id]));
    const recvIds = new Map(recvReqs.map(r => [r.senderId, r.id]));

    const usersWithRelation = users.map((u: any) => {
        let relation = 'none';
        let requestId = null;

        if (friendIds.has(u.id)) {
            relation = 'friend';
        } else if (sentIds.has(u.id)) {
            relation = 'request_sent';
            requestId = sentIds.get(u.id);
        } else if (recvIds.has(u.id)) {
            relation = 'request_received';
            requestId = recvIds.get(u.id);
        }

        return { ...u, relation, requestId };
    });

    res.json({ success: true, users: usersWithRelation });
}));

// ============= REQUEST ROUTES =============

/**
 * POST /friends/request - Gửi lời mời kết bạn
 */
friendRoutes.post('/request', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const { receiverId } = req.body;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    if (!receiverId) {
        return res.status(400).json({ success: false, message: 'Thiếu receiverId!' });
    }

    const request = await friendService.sendRequest(userId, receiverId);
    res.json({ success: true, message: 'Đã gửi lời mời kết bạn!', request });
}));

/**
 * GET /friends/requests/received - Lấy lời mời đã nhận
 */
friendRoutes.get('/requests/received', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    const requests = await friendService.getReceivedRequests(userId);
    res.json({ success: true, requests });
}));

/**
 * GET /friends/requests/sent - Lấy lời mời đã gửi
 */
friendRoutes.get('/requests/sent', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    const requests = await friendService.getSentRequests(userId);
    res.json({ success: true, requests });
}));

/**
 * POST /friends/accept/:requestId - Chấp nhận lời mời
 */
friendRoutes.post('/accept/:requestId', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const requestId = req.params.requestId as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    const friendship = await friendService.acceptRequest(requestId, userId);
    
    // Ở đây ta có thể trả về một chatId giả định hoặc thực hiện tạo chat nếu cần
    // Nhưng frontend usually gọi getOrCreatePrivateChat ngay sau đó.
    res.json({ success: true, message: 'Đã chấp nhận lời mời!', friendship });
}));

/**
 * DELETE /friends/reject/:requestId - Từ chối lời mời
 */
friendRoutes.delete('/reject/:requestId', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const requestId = req.params.requestId as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    await friendService.rejectRequest(requestId, userId);
    res.json({ success: true, message: 'Đã từ chối lời mời!' });
}));

/**
 * DELETE /friends/cancel/:requestId - Hủy lời mời đã gửi
 */
friendRoutes.delete('/cancel/:requestId', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const requestId = req.params.requestId as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    await friendService.cancelRequest(requestId, userId);
    res.json({ success: true, message: 'Đã hủy lời mời!' });
}));

// ============= BLOCK ROUTES =============

/**
 * POST /friends/block/:userId - Chặn người dùng
 */
friendRoutes.post('/block/:userId', asyncHandler(async (req: Request, res: Response) => {
    const currentUserId = req.headers['x-user-id'] as string;
    const targetUserId = req.params.userId as string;

    if (!currentUserId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    await friendService.blockUser(currentUserId, targetUserId);
    res.json({ success: true, message: 'Đã chặn người dùng!' });
}));

/**
 * DELETE /friends/unblock/:userId - Bỏ chặn
 */
friendRoutes.delete('/unblock/:userId', asyncHandler(async (req: Request, res: Response) => {
    const currentUserId = req.headers['x-user-id'] as string;
    const targetUserId = req.params.userId as string;

    if (!currentUserId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    await friendService.unblockUser(currentUserId, targetUserId);
    res.json({ success: true, message: 'Đã bỏ chặn người dùng!' });
}));

/**
 * GET /friends/blocked - Danh sách chặn
 */
friendRoutes.get('/blocked', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    const blockedUsers = await friendService.getBlockedUsers(userId);
    res.json({ success: true, blockedUsers });
}));

// ============= INTERNAL ROUTES =============

/**
 * GET /internal/check-friendship - Kiểm tra quan hệ bạn bè (Cho Chat Service)
 */
friendRoutes.get('/internal/check-friendship', asyncHandler(async (req: Request, res: Response) => {
    const { user1Id, user2Id } = req.query as { user1Id: string, user2Id: string };

    if (!user1Id || !user2Id) {
        return res.status(400).json({ success: false, message: 'Thiếu ID người dùng!' });
    }

    const isFriend = await friendService.checkFriendship(user1Id, user2Id);
    res.json({ success: true, isFriend });
}));

/**
 * GET /internal/check-blocked - Kiểm tra trạng thái chặn (Cho Chat Service)
 */
friendRoutes.get('/internal/check-blocked', asyncHandler(async (req: Request, res: Response) => {
    const { user1Id, user2Id } = req.query as { user1Id: string, user2Id: string };

    if (!user1Id || !user2Id) {
        return res.status(400).json({ success: false, message: 'Thiếu ID người dùng!' });
    }

    const result = await friendService.checkBlockedStatus(user1Id, user2Id);
    res.json({ success: true, ...result });
}));
