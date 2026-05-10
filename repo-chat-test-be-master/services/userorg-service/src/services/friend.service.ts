// services/userorg-service/src/services/friend.service.ts

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export class FriendService {
    /**
     * Gửi lời mời kết bạn
     */
    async sendRequest(senderId: string, receiverId: string) {
        if (senderId === receiverId) {
            throw new Error('Không thể kết bạn với chính mình!');
        }

        // Kiểm tra xem đã là bạn bè chưa
        const existingFriend = await prisma.friend.findFirst({
            where: {
                OR: [
                    { user1Id: senderId, user2Id: receiverId },
                    { user1Id: receiverId, user2Id: senderId }
                ]
            }
        });

        if (existingFriend) {
            throw new Error('Hai người đã là bạn bè!');
        }

        // Kiểm tra xem có lời mời nào đang chờ không
        const existingRequest = await prisma.friendRequest.findFirst({
            where: {
                OR: [
                    { senderId: senderId, receiverId: receiverId },
                    { senderId: receiverId, receiverId: senderId }
                ]
            }
        });

        if (existingRequest) {
            if (existingRequest.senderId === senderId) {
                throw new Error('Bạn đã gửi lời mời kết bạn trước đó!');
            } else {
                throw new Error('Người này đã gửi lời mời kết bạn cho bạn!');
            }
        }

        // Tạo lời mời mới
        const request = await prisma.friendRequest.create({
            data: {
                senderId,
                receiverId
            },
            include: {
                sender: {
                    select: { id: true, name: true, avatar: true }
                }
            }
        });

        // Publish event
        await publishEvent(EventSubjects.FRIEND_REQUEST_SENT, {
            requestId: request.id,
            senderId,
            receiverId,
            senderName: request.sender.name,
            senderAvatar: request.sender.avatar
        });

        return request;
    }

    /**
     * Chấp nhận lời mời kết bạn
     */
    async acceptRequest(requestId: string, currentUserId: string) {
        const request = await prisma.friendRequest.findUnique({
            where: { id: requestId },
            include: { sender: true, receiver: true }
        });

        if (!request) {
            throw new Error('Không tìm thấy lời mời kết bạn!');
        }

        if (request.receiverId !== currentUserId) {
            throw new Error('Bạn không có quyền chấp nhận lời mời này!');
        }

        // Thực hiện transaction: Xóa lời mời và Thêm vào bảng bạn bè
        const [friendship] = await prisma.$transaction([
            prisma.friend.create({
                data: {
                    user1Id: request.senderId,
                    user2Id: request.receiverId
                }
            }),
            prisma.friendRequest.delete({
                where: { id: requestId }
            })
        ]);

        // Publish event
        await publishEvent(EventSubjects.FRIEND_REQUEST_ACCEPTED, {
            requestId,
            senderId: request.senderId,
            receiverId: request.receiverId,
            receiverName: request.receiver.name
        });

        // Publish internal event to create chat (optional, handled by frontend usually but good for backend consistency)
        // Here we just return the friendship
        return friendship;
    }

    /**
     * Từ chối lời mời kết bạn
     */
    async rejectRequest(requestId: string, currentUserId: string) {
        const request = await prisma.friendRequest.findUnique({
            where: { id: requestId }
        });

        if (!request) {
            throw new Error('Không tìm thấy lời mời kết bạn!');
        }

        if (request.receiverId !== currentUserId) {
            throw new Error('Bạn không có quyền từ chối lời mời này!');
        }

        await prisma.friendRequest.delete({
            where: { id: requestId }
        });

        // Publish event
        await publishEvent(EventSubjects.FRIEND_REQUEST_REJECTED, {
            requestId,
            senderId: request.senderId,
            receiverId: request.receiverId
        });

        return { success: true };
    }

    /**
     * Hủy lời mời kết bạn đã gửi
     */
    async cancelRequest(requestId: string, currentUserId: string) {
        const request = await prisma.friendRequest.findUnique({
            where: { id: requestId }
        });

        if (!request) {
            throw new Error('Không tìm thấy lời mời kết bạn!');
        }

        if (request.senderId !== currentUserId) {
            throw new Error('Bạn không có quyền hủy lời mời này!');
        }

        await prisma.friendRequest.delete({
            where: { id: requestId }
        });

        // Publish event
        await publishEvent(EventSubjects.FRIEND_REQUEST_CANCELLED, {
            requestId,
            senderId: request.senderId,
            receiverId: request.receiverId
        });

        return { success: true };
    }

    /**
     * Lấy danh sách bạn bè
     */
    async getFriends(userId: string, search?: string) {
        const friendships = await prisma.friend.findMany({
            where: {
                OR: [
                    { user1Id: userId },
                    { user2Id: userId }
                ],
                // Nếu có search, chúng ta sẽ filter ở dưới vì Prisma không support tốt OR lồng nhau với relations phức tạp ở mức này
            },
            include: {
                user1: {
                    select: { id: true, name: true, avatar: true, status: true, isOnline: true, lastSeen: true }
                },
                user2: {
                    select: { id: true, name: true, avatar: true, status: true, isOnline: true, lastSeen: true }
                }
            }
        });

        // Map lại để lấy object friend (đối phương)
        let friends = friendships.map(f => {
            return f.user1Id === userId ? f.user2 : f.user1;
        });

        if (search) {
            const lowSearch = search.toLowerCase();
            friends = friends.filter(f => f.name.toLowerCase().includes(lowSearch));
        }

        return friends;
    }

    /**
     * Lấy lời mời đã nhận
     */
    async getReceivedRequests(userId: string) {
        return prisma.friendRequest.findMany({
            where: { receiverId: userId },
            include: {
                sender: {
                    select: { id: true, name: true, avatar: true, status: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    /**
     * Lấy lời mời đã gửi
     */
    async getSentRequests(userId: string) {
        return prisma.friendRequest.findMany({
            where: { senderId: userId },
            include: {
                receiver: {
                    select: { id: true, name: true, avatar: true, status: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    /**
     * Hủy kết bạn
     */
    async unfriend(userId: string, friendId: string) {
        await prisma.friend.deleteMany({
            where: {
                OR: [
                    { user1Id: userId, user2Id: friendId },
                    { user1Id: friendId, user2Id: userId }
                ]
            }
        });

        // Publish event
        await publishEvent(EventSubjects.FRIEND_UNFRIENDED, {
            userId,
            friendId
        });

        return { success: true };
    }

    /**
     * Chặn người dùng
     */
    async blockUser(blockerId: string, blockedId: string) {
        if (blockerId === blockedId) {
            throw new Error('Không thể tự chặn chính mình!');
        }

        // Xóa quan hệ bạn bè và lời mời nếu có
        await prisma.$transaction([
            prisma.blockedUser.upsert({
                where: {
                    blockerAccountId_blockedAccountId: {
                        blockerAccountId: blockerId,
                        blockedAccountId: blockedId
                    }
                },
                create: {
                    blockerAccountId: blockerId,
                    blockedAccountId: blockedId
                },
                update: {}
            }),
            prisma.friend.deleteMany({
                where: {
                    OR: [
                        { user1Id: blockerId, user2Id: blockedId },
                        { user1Id: blockedId, user2Id: blockerId }
                    ]
                }
            }),
            prisma.friendRequest.deleteMany({
                where: {
                    OR: [
                        { senderId: blockerId, receiverId: blockedId },
                        { senderId: blockedId, receiverId: blockerId }
                    ]
                }
            })
        ]);

        // Publish event
        await publishEvent(EventSubjects.FRIEND_USER_BLOCKED, {
            blockerId,
            blockedId
        });

        return { success: true };
    }

    /**
     * Bỏ chặn
     */
    async unblockUser(blockerId: string, blockedId: string) {
        const result = await prisma.blockedUser.deleteMany({
            where: {
                blockerAccountId: blockerId,
                blockedAccountId: blockedId
            }
        });

        if (result.count === 0) {
            // Trường hợp User B cố tình unblock User A (trong khi A là người chặn)
            // Hoặc bản ghi đã bị xóa trước đó
            throw new Error('Bạn không có quyền mở chặn cho người dùng này hoặc quan hệ chặn không tồn tại!');
        }

        // Publish event (Chỉ thực hiện khi xóa DB thành công)
        await publishEvent(EventSubjects.FRIEND_USER_UNBLOCKED, {
            blockerId,
            blockedId
        });

        return { success: true };
    }

    /**
     * Lấy danh sách chặn
     */
    async getBlockedUsers(userId: string) {
        const blockedLinks = await prisma.blockedUser.findMany({
            where: { blockerAccountId: userId },
            include: {
                blockedAccount: {
                    select: { id: true, name: true, avatar: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        return blockedLinks.map(l => ({
            id: l.id,
            user: l.blockedAccount,
            blockedAt: l.createdAt
        }));
    }

    /**
     * Kiểm tra quan hệ bạn bè (Internal API)
     */
    async checkFriendship(user1Id: string, user2Id: string) {
        const friendship = await prisma.friend.findFirst({
            where: {
                OR: [
                    { user1Id: user1Id, user2Id: user2Id },
                    { user1Id: user2Id, user2Id: user1Id }
                ]
            }
        });

        return !!friendship;
    }

    /**
     * Kiểm tra trạng thái chặn giữa hai người (Internal API)
     */
    async checkBlockedStatus(user1Id: string, user2Id: string) {
        const block = await prisma.blockedUser.findFirst({
            where: {
                OR: [
                    { blockerAccountId: user1Id, blockedAccountId: user2Id },
                    { blockerAccountId: user2Id, blockedAccountId: user1Id }
                ]
            }
        });

        if (!block) return { isBlocked: false };

        return {
            isBlocked: true,
            blockerId: block.blockerAccountId,
            isBlockedByMe: block.blockerAccountId === user1Id
        };
    }
}

export const friendService = new FriendService();
