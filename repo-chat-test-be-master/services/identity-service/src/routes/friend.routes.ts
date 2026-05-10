// services/identity-service/src/routes/friend.routes.ts
// Migrated from userorg-service

import { Router } from 'express';
import type { Request, Response } from 'express';
import { friendService } from '../services/friend.service.js';
import { userService } from '../services/user.service.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const friendRoutes = Router();

friendRoutes.get('/', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    const friends = await friendService.getFriends(userId, req.query.search as string);
    res.json({ success: true, friends });
}));

friendRoutes.delete('/:friendId', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const userRole = req.headers['x-user-role'] as string;
    const userRolesStr = req.headers['x-user-roles'] as string;

    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

    // Kiểm tra quyền Admin
    const isAdmin = !!(userRole === 'SUPER_ADMIN' || userRole === 'ADMIN' || 
                   (userRolesStr && userRolesStr.includes('SUPER_ADMIN')));

    await friendService.unfriend(userId, req.params.friendId as string, isAdmin);
    res.json({ success: true, message: 'Đã hủy kết bạn!' });
}));

friendRoutes.get('/search', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const q = req.query.q as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    if (!q || q.length < 2) return res.json({ success: true, users: [] });

    const users = await userService.searchDirectory(q, userId);
    const friends = await friendService.getFriends(userId);
    const sentReqs = await friendService.getSentRequests(userId);
    const recvReqs = await friendService.getReceivedRequests(userId);

    const friendIds = new Set(friends.map((f: any) => f.id));
    const sentIds = new Map(sentReqs.map((r: any) => [r.receiverId, r.id]));
    const recvIds = new Map(recvReqs.map((r: any) => [r.senderId, r.id]));

    const usersWithRelation = users.map((u: any) => {
        let relation = 'none', requestId = null;
        if (friendIds.has(u.id)) relation = 'friend';
        else if (sentIds.has(u.id)) { relation = 'request_sent'; requestId = sentIds.get(u.id); }
        else if (recvIds.has(u.id)) { relation = 'request_received'; requestId = recvIds.get(u.id); }
        return { ...u, relation, requestId };
    });
    res.json({ success: true, users: usersWithRelation });
}));

friendRoutes.post('/request', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    if (!req.body.receiverId) return res.status(400).json({ success: false, message: 'Thiếu receiverId!' });
    const request = await friendService.sendRequest(userId, req.body.receiverId);
    res.json({ success: true, message: 'Đã gửi lời mời kết bạn!', request });
}));

friendRoutes.get('/requests/received', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    const requests = await friendService.getReceivedRequests(userId);
    res.json({ success: true, requests });
}));

friendRoutes.get('/requests/sent', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    const requests = await friendService.getSentRequests(userId);
    res.json({ success: true, requests });
}));

friendRoutes.post('/accept/:requestId', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    const result = await friendService.acceptRequest(req.params.requestId as string, userId);
    res.json({ success: true, message: 'Đã chấp nhận lời mời!', friendship: result.friendship, chatId: result.chatId });
}));

friendRoutes.delete('/reject/:requestId', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    await friendService.rejectRequest(req.params.requestId as string, userId);
    res.json({ success: true, message: 'Đã từ chối lời mời!' });
}));

friendRoutes.delete('/cancel/:requestId', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    await friendService.cancelRequest(req.params.requestId as string, userId);
    res.json({ success: true, message: 'Đã hủy lời mời!' });
}));

friendRoutes.post('/block/:userId', asyncHandler(async (req: Request, res: Response) => {
    const currentUserId = req.headers['x-user-id'] as string;
    if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    await friendService.blockUser(currentUserId, req.params.userId as string);
    res.json({ success: true, message: 'Đã chặn người dùng!' });
}));

friendRoutes.delete('/unblock/:userId', asyncHandler(async (req: Request, res: Response) => {
    const currentUserId = req.headers['x-user-id'] as string;
    const userRole = req.headers['x-user-role'] as string;
    const userRolesStr = req.headers['x-user-roles'] as string;
    
    if (!currentUserId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });

    // Kiểm tra nếu là ADMIN
    const isAdmin = !!(userRole === 'SUPER_ADMIN' || userRole === 'ADMIN' || 
                   (userRolesStr && userRolesStr.includes('SUPER_ADMIN')));

    await friendService.unblockUser(currentUserId, req.params.userId as string, isAdmin);
    res.json({ success: true, message: 'Đã bỏ chặn người dùng!' });
}));

friendRoutes.get('/blocked', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    const blockedUsers = await friendService.getBlockedUsers(userId);
    res.json({ success: true, blockedUsers });
}));

friendRoutes.get('/internal/check-friendship', asyncHandler(async (req: Request, res: Response) => {
    const { user1Id, user2Id } = req.query as { user1Id: string; user2Id: string };
    if (!user1Id || !user2Id) return res.status(400).json({ success: false, message: 'Thiếu ID người dùng!' });
    const isFriend = await friendService.checkFriendship(user1Id, user2Id);
    res.json({ success: true, isFriend });
}));

friendRoutes.get('/internal/check-blocked', asyncHandler(async (req: Request, res: Response) => {
    const { user1Id, user2Id } = req.query as { user1Id: string; user2Id: string };
    if (!user1Id || !user2Id) return res.status(400).json({ success: false, message: 'Thiếu ID người dùng!' });
    const result = await friendService.checkBlockedStatus(user1Id, user2Id);
    res.json({ success: true, ...result });
}));
