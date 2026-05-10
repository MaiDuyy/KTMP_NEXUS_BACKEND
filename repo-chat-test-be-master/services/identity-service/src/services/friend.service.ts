// services/identity-service/src/services/friend.service.ts
// Migrated from userorg-service — prisma → userorgPrisma

import { userorgPrisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';



export class FriendService {
    async sendRequest(senderId: string, receiverId: string) {
        if (senderId === receiverId) throw new Error('Không thể kết bạn với chính mình!');

        const [u1, u2] = [senderId, receiverId].sort();
        const existingFriend = await userorgPrisma.friend.findUnique({
            where: { user1Id_user2Id: { user1Id: u1, user2Id: u2 } }
        });
        if (existingFriend) throw new Error('Hai người đã là bạn bè!');

        const existingRequest = await userorgPrisma.friendRequest.findFirst({
            where: { OR: [{ senderId, receiverId }, { senderId: receiverId, receiverId: senderId }] }
        });
        if (existingRequest) {
            throw new Error(existingRequest.senderId === senderId
                ? 'Bạn đã gửi lời mời kết bạn trước đó!'
                : 'Người này đã gửi lời mời kết bạn cho bạn!');
        }

        const receiver = await userorgPrisma.account.findUnique({
            where: { id: receiverId },
            select: { name: true }
        });
        if (!receiver) throw new Error('Người dùng không tồn tại!');

        const request = await userorgPrisma.friendRequest.create({
            data: { senderId, receiverId },
            include: { sender: { select: { id: true, name: true, avatar: true } } }
        });

        console.log(`[FriendService] Publishing FRIEND_REQUEST_SENT from ${senderId} to ${receiverId} (${receiver.name})`);
        await publishEvent(EventSubjects.FRIEND_REQUEST_SENT, {
            requestId: request.id, 
            senderId, 
            receiverId,
            senderName: request.sender.name, 
            senderAvatar: request.sender.avatar,
            receiverName: receiver.name
        });

        return request;
    }

    async acceptRequest(requestId: string, currentUserId: string) {
        const request = await userorgPrisma.friendRequest.findUnique({
            where: { id: requestId }, include: { sender: true, receiver: true }
        });
        if (!request) throw new Error('Không tìm thấy lời mời kết bạn!');
        if (request.receiverId !== currentUserId) throw new Error('Bạn không có quyền chấp nhận lời mời này!');

        const [u1, u2] = [request.senderId, request.receiverId].sort();
        
        try {
            const [friendship] = await userorgPrisma.$transaction([
                userorgPrisma.friend.create({ data: { user1Id: u1, user2Id: u2 } }),
                userorgPrisma.friendRequest.delete({ where: { id: requestId } })
            ]);
            
            // Try to get/create private chat via messaging-service for chatId
            let chatId = '';
            try {
                const messagingUrl = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3020';
                const chatResponse = await fetch(`${messagingUrl}/chats/private`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-user-id': currentUserId,
                    },
                    body: JSON.stringify({ partnerId: request.senderId }),
                });
                if (chatResponse.ok) {
                    const chatData = await chatResponse.json() as any;
                    chatId = chatData?.chat?.id || '';
                }
            } catch (err: any) {
                console.warn(`[FriendService] Failed to get/create private chat: ${err.message}`);
            }

            console.log(`[FriendService] Publishing FRIEND_REQUEST_ACCEPTED between ${request.senderId} and ${request.receiverId}, chatId: ${chatId}`);
            await publishEvent(EventSubjects.FRIEND_REQUEST_ACCEPTED, {
                requestId, 
                senderId: request.senderId, 
                receiverId: request.receiverId, 
                receiverName: request.receiver.name,
                receiverAvatar: request.receiver.avatar,
                senderName: request.sender.name,
                senderAvatar: request.sender.avatar,
                chatId
            });

            return { friendship, chatId };
        } catch (error: any) {
            console.error(`[FriendService] Error in acceptRequest: ${error.message}`, error);
            if (error.code === 'P2002') throw new Error('Hai người đã là bạn bè hoặc yêu cầu đã được xử lý!');
            throw error;
        }
    }

    async rejectRequest(requestId: string, currentUserId: string) {
        const request = await userorgPrisma.friendRequest.findUnique({ 
            where: { id: requestId },
            include: { sender: { select: { name: true } }, receiver: { select: { name: true } } }
        });
        if (!request) throw new Error('Không tìm thấy lời mời kết bạn!');
        if (request.receiverId !== currentUserId) throw new Error('Bạn không có quyền từ chối lời mời này!');

        await userorgPrisma.friendRequest.delete({ where: { id: requestId } });
        await publishEvent(EventSubjects.FRIEND_REQUEST_REJECTED, { 
            requestId, 
            senderId: request.senderId, 
            receiverId: request.receiverId,
            senderName: request.sender.name,
            receiverName: request.receiver.name
        });
        return { success: true };
    }

    async cancelRequest(requestId: string, currentUserId: string) {
        const request = await userorgPrisma.friendRequest.findUnique({ 
            where: { id: requestId },
            include: { sender: { select: { name: true } }, receiver: { select: { name: true } } }
        });
        if (!request) throw new Error('Không tìm thấy lời mời kết bạn!');
        if (request.senderId !== currentUserId) throw new Error('Bạn không có quyền hủy lời mời này!');

        await userorgPrisma.friendRequest.delete({ where: { id: requestId } });
        await publishEvent(EventSubjects.FRIEND_REQUEST_CANCELLED, { 
            requestId, 
            senderId: request.senderId, 
            receiverId: request.receiverId,
            senderName: request.sender.name,
            receiverName: request.receiver.name
        });
        return { success: true };
    }

    async getFriends(userId: string, search?: string) {
        const friendships = await userorgPrisma.friend.findMany({
            where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
            include: {
                user1: { select: { id: true, name: true, avatar: true, status: true, isOnline: true, lastSeen: true } },
                user2: { select: { id: true, name: true, avatar: true, status: true, isOnline: true, lastSeen: true } }
            }
        });

        let friends = friendships.map((f: any) => f.user1Id === userId ? f.user2 : f.user1);
        if (search) {
            const lowSearch = search.toLowerCase();
            friends = friends.filter((f: any) => f.name.toLowerCase().includes(lowSearch));
        }
        return friends;
    }

    async getReceivedRequests(userId: string) {
        return userorgPrisma.friendRequest.findMany({
            where: { receiverId: userId },
            include: { sender: { select: { id: true, name: true, avatar: true, status: true } } },
            orderBy: { createdAt: 'desc' }
        });
    }

    async getSentRequests(userId: string) {
        return userorgPrisma.friendRequest.findMany({
            where: { senderId: userId },
            include: { receiver: { select: { id: true, name: true, avatar: true, status: true } } },
            orderBy: { createdAt: 'desc' }
        });
    }

    async unfriend(userId: string, friendId: string, isAdmin: boolean = false) {
        logger.info(`Attempting to unfriend. Requester: ${userId}, Target: ${friendId}, IsAdmin: ${isAdmin}`);

        // Bảo vệ SUPER_ADMIN: Không cho phép người dùng thường hủy kết bạn với Admin
        const targetUser = await userorgPrisma.account.findUnique({
            where: { id: friendId },
            select: { role: true }
        });

        if (targetUser?.role === 'SUPER_ADMIN' && !isAdmin) {
             throw new Error('Bạn không thể hủy kết bạn với tài khoản Quản trị viên hệ thống!');
        }

        const [u1, u2] = [userId, friendId].sort();
        const result = await userorgPrisma.friend.deleteMany({
            where: { user1Id: u1, user2Id: u2 }
        });

        if (result.count === 0) {
            logger.warn(`Unfriend failed: No friendship found between ${userId} and ${friendId}`);
            throw new Error('Quan hệ bạn bè không tồn tại!');
        }

        logger.info(`Successfully unfriended ${userId} and ${friendId}`);
        await publishEvent(EventSubjects.FRIEND_UNFRIENDED, { 
            userId, 
            friendId,
            unfriendedBy: userId 
        });
        
        return { success: true };
    }

    async blockUser(blockerId: string, blockedId: string) {
        logger.info(`Attempting to block user. Blocker: ${blockerId}, Blocked: ${blockedId}`);
        
        if (blockerId === blockedId) {
            logger.warn(`Block attempt failed: User ${blockerId} tried to block themselves.`);
            throw new Error('Không thể tự chặn chính mình!');
        }

        // Kiểm tra xem người bị chặn có phải là SUPER_ADMIN không
        const targetUser = await userorgPrisma.account.findUnique({
            where: { id: blockedId },
            select: { role: true }
        });

        if (targetUser?.role === 'SUPER_ADMIN') {
            throw new Error('Không thể chặn tài khoản Quản trị viên hệ thống!');
        }

        try {
            await userorgPrisma.$transaction([
                userorgPrisma.blockedUser.upsert({
                    where: { blockerAccountId_blockedAccountId: { blockerAccountId: blockerId, blockedAccountId: blockedId } },
                    create: { blockerAccountId: blockerId, blockedAccountId: blockedId },
                    update: {}
                }),
                userorgPrisma.friend.deleteMany({
                    where: { OR: [{ user1Id: blockerId, user2Id: blockedId }, { user1Id: blockedId, user2Id: blockerId }] }
                }),
                userorgPrisma.friendRequest.deleteMany({
                    where: { OR: [{ senderId: blockerId, receiverId: blockedId }, { senderId: blockedId, receiverId: blockerId }] }
                })
            ]);

            logger.info(`Successfully blocked user ${blockedId} for blocker ${blockerId}`);
            await publishEvent(EventSubjects.FRIEND_USER_BLOCKED, { blockerId, blockedId });
            return { success: true };
        } catch (error) {
            logger.error(`Error in blockUser: ${error}`);
            throw error;
        }
    }

    async unblockUser(blockerId: string, blockedId: string, isAdmin: boolean = false) {
        logger.info(`Attempting to unblock user. Requester: ${blockerId}, Target: ${blockedId}, IsAdmin: ${isAdmin}`);
        
        // Kiểm tra xem người bị chặn có phải là SUPER_ADMIN không
        const targetUser = await userorgPrisma.account.findUnique({
            where: { id: blockedId },
            select: { role: true }
        });

        if (targetUser?.role === 'SUPER_ADMIN' && !isAdmin) {
            throw new Error('Bạn không có quyền gỡ chặn cho tài khoản Quản trị viên hệ thống!');
        }

        let whereClause: any = { blockerAccountId: blockerId, blockedAccountId: blockedId };
        
        if (isAdmin) {
            whereClause = {
                OR: [
                    { blockerAccountId: blockerId, blockedAccountId: blockedId },
                    { blockerAccountId: blockedId, blockedAccountId: blockerId }
                ]
            };
        }

        const result = await userorgPrisma.blockedUser.deleteMany({
            where: whereClause
        });

        if (result.count === 0) {
            logger.warn(`Unblock failed: No block relationship found between ${blockerId} and ${blockedId}`);
            throw new Error('Bạn không có quyền mở chặn cho người dùng này hoặc quan hệ chặn không tồn tại!');
        }

        logger.info(`Successfully unblocked ${result.count} record(s) between ${blockedId} and ${blockerId}`);
        
        // Publish event cho real-time
        await publishEvent(EventSubjects.FRIEND_USER_UNBLOCKED, { 
            blockerId, 
            blockedId,
            unblockedBy: blockerId 
        });
        
        return { success: true };
    }

    async getBlockedUsers(userId: string) {
        const blockedLinks = await userorgPrisma.blockedUser.findMany({
            where: { blockerAccountId: userId },
            include: { blockedAccount: { select: { id: true, name: true, avatar: true } } },
            orderBy: { createdAt: 'desc' }
        });
        return blockedLinks.map((l : any) => ({ id: l.id, user: l.blockedAccount, blockedAt: l.createdAt }));
    }

    async checkFriendship(user1Id: string, user2Id: string) {
        const friendship = await userorgPrisma.friend.findFirst({
            where: { OR: [{ user1Id, user2Id }, { user1Id: user2Id, user2Id: user1Id }] }
        });
        return !!friendship;
    }

    async checkBlockedStatus(user1Id: string, user2Id: string) {
        const block = await userorgPrisma.blockedUser.findFirst({
            where: { OR: [{ blockerAccountId: user1Id, blockedAccountId: user2Id }, { blockerAccountId: user2Id, blockedAccountId: user1Id }] }
        });
        if (!block) return { isBlocked: false };
        return { isBlocked: true, blockerId: block.blockerAccountId, isBlockedByMe: block.blockerAccountId === user1Id };
    }
}

export const friendService = new FriendService();
