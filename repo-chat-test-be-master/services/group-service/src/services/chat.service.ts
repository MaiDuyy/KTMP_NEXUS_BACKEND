// services/group-service/src/services/chat.service.ts
// Migrate từ src/controllers/chat.controller.ts

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { internalFetch } from '@ott/shared';

export class ChatService {
  /**
   * Lấy danh sách chat của user
   */
  async getChats(userId: string, type?: 'all' | 'private' | 'group') {
    const whereCondition: any = {
      participants: {
        some: {
          accountId: userId,
          hidden: false,
        },
      },
    };

    if (type === 'private') {
      whereCondition.isGroup = false;
    } else if (type === 'group') {
      whereCondition.isGroup = true;
    }

    const chats = await prisma.chat.findMany({
      where: whereCondition,
      include: {
        participants: true,
      },
      
      orderBy: { updatedAt: 'desc' },
    });

    // Get user details from userorg-service via HTTP
    const uniqueAccountIds = [...new Set(chats.flatMap(c => c.participants.map(p => p.accountId)))];
    let accountMap = new Map<string, any>();
    
    if (uniqueAccountIds.length > 0) {
      try {
        const USERORG_URL = process.env.USERORG_SERVICE_URL || 'http://localhost:3011';
        const response = await fetch(`${USERORG_URL}/users/batch?ids=${uniqueAccountIds.join(',')}`);
      // const response =   await internalFetch(`${USERORG_URL}/users/batch?ids=ids=${uniqueAccountIds.join(',')}`, {}, { userId });
        if (response.ok) {
          const data = (await response.json()) as any;
          if (data && data.users) {
            data.users.forEach((u: any) => accountMap.set(u.id, u));
          }
        }
      } catch (err) {
        console.error('[ChatService] Failed to fetch user profiles for chats', err);
      }
    }

    // FETCH LAST MESSAGES AND UNREAD COUNTS FROM CHAT-SERVICE
    let summaryMap = new Map<string, any>();
    if (chats.length > 0) {
      try {
        // Resolve URL: Nếu chạy trong Docker, localhost sẽ không chạy được
        let CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL;
        if (!CHAT_SERVICE_URL) {
          // Đoán URL dựa trên USERORG_SERVICE_URL (nếu dùng service name trong docker)
          const userorgUrl = process.env.USERORG_SERVICE_URL || '';
          if (userorgUrl.includes('userorg-service')) {
            CHAT_SERVICE_URL = 'http://chat-service:3013';
          } else {
            CHAT_SERVICE_URL = 'http://localhost:3013';
          }
        }

        const chatIds = chats.map(c => c.id).join(',');
        
        // Pass userId in header for unread count calculation
        const url = `${CHAT_SERVICE_URL}/messages/summary?chatIds=${chatIds}`;
        const response = await fetch(url, {
          headers: { 'x-user-id': userId }
        });

        if (response.ok) {
          const data = (await response.json()) as any;
          if (data && data.summary) {
            data.summary.forEach((item: any) => summaryMap.set(item.chatId, item));
          }
        } else {
          console.error(`[ChatService] Chat-service returned status ${response.status} for ${url}`);
        }
      } catch (err) {
        console.error('[ChatService] Failed to fetch summaries from chat-service. Ensure CHAT_SERVICE_URL is correct.', err);
      }
    }

    // Format response
    const formattedChats = await Promise.all(chats.map(async (chat) => {
      const myParticipant = chat.participants.find((p) => p.accountId === userId);
      const otherParticipants = chat.participants.filter((p) => p.accountId !== userId);
      
      const summary = summaryMap.get(chat.id);

      // Check if blocked (for private chats)
      // ... (giữ nguyên logic check block)
      let isBlocked = false;
      let isBlockedByMe = false;
      if (!chat.isGroup && otherParticipants.length > 0) {
        try {
          const partnerId = otherParticipants[0].accountId;
          const USERORG_URL = process.env.USERORG_SERVICE_URL || 'http://localhost:3011';
          
          const blockRes = await fetch(`${USERORG_URL}/friends/internal/check-blocked?user1Id=${userId}&user2Id=${partnerId}`);
          if (blockRes.ok) {
            const blockData = await blockRes.json() as any;
            isBlocked = !!blockData.isBlocked;
            isBlockedByMe = !!blockData.isBlockedByMe;
          }
        } catch (err) {
          console.error('[ChatService] Failed to check block status in list', err);
        }
      }
    
      return {
        id: chat.id,
        name: chat.name,
        avatar: chat.avatar,
        isGroup: chat.isGroup,
        isBlocked,
        isBlockedByMe,
        pin: myParticipant?.pin || false,
        notify: myParticipant?.notify ?? true,
        readed: myParticipant?.readed ?? false,
        lastMessage: summary?.lastMessage || null,
        unreadCount: summary?.unreadCount || 0,
        participantIds: otherParticipants.map((p) => p.accountId),
        participants: chat.participants.map((p) => {
          const acc = accountMap.get(p.accountId);
          return {
            participantId: p.id,
            accountId: p.accountId,
            role: p.role,
            name: acc?.name,
            avatar: acc?.avatar,
            isOnline: acc?.isOnline,
            userStatus: acc?.userStatus || acc?.status,
          };
        }),
        participantCount: chat.participants.length,
        updatedAt: chat.updatedAt,
        createdAt: chat.createdAt,
      };
    }));

    // Sort: pinned first, then by last message time, then by updatedAt
    formattedChats.sort((a, b) => {
      if (a.pin && !b.pin) return -1;
      if (!a.pin && b.pin) return 1;
      
      const aTime = a.lastMessage?.time || a.updatedAt;
      const bTime = b.lastMessage?.time || b.updatedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    return formattedChats;
  }

  /**
   * Lấy thông tin chi tiết chat
   */
  async getChatById(chatId: string, userId: string) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: true,
      },
    });

    if (!chat) {
      throw new Error('Không tìm thấy chat!');
    }

    // Check user is participant
    const isParticipant = chat.participants.some((p) => p.accountId === userId);
    if (!isParticipant) {
      throw new Error('Bạn không có quyền xem chat này!');
    }

    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    const otherParticipants = chat.participants.filter((p) => p.accountId !== userId);

    const uniqueAccountIds = [...new Set(chat.participants.map(p => p.accountId))];
    let accountMap = new Map<string, any>();
    
    if (uniqueAccountIds.length > 0) {
      try {
        const USERORG_URL = process.env.USERORG_SERVICE_URL || 'http://localhost:3011';
        const response = await fetch(`${USERORG_URL}/users/batch?ids=${uniqueAccountIds.join(',')}`);
          //  const response =   await internalFetch(`${USERORG_URL}/users/batch?ids=ids=${uniqueAccountIds.join(',')}`, {}, { userId });
        if (response.ok) {
          const data = (await response.json()) as any;
          if (data && data.users) {
            data.users.forEach((u: any) => accountMap.set(u.id, u));
          }
        }
      } catch (err) {
        console.error('[ChatService] Failed to fetch user profiles for chat item', err);
      }
    }

    // Check if blocked (for private chats)
    let isBlocked = false;
    let isBlockedByMe = false;
    if (!chat.isGroup) {
      const partner = chat.participants.find(p => p.accountId !== userId);
      if (partner) {
        try {
          const USERORG_URL = process.env.USERORG_SERVICE_URL || 'http://localhost:3011';
          const response = await fetch(`${USERORG_URL}/friends/internal/check-blocked?user1Id=${userId}&user2Id=${partner.accountId}`);

          if (response.ok) {
            const blockData = await response.json() as any;
            isBlocked = !!blockData.isBlocked;
            isBlockedByMe = !!blockData.isBlockedByMe;
          }
        } catch (error) {
          console.error('[ChatService] Error checking blocked status:', error);
        }
      }
    }

    return {
      id: chat.id,
      name: chat.name,
      avatar: chat.avatar,
      isGroup: chat.isGroup,
      isBlocked,
      isBlockedByMe,
      pin: myParticipant?.pin || false,
      notify: myParticipant?.notify ?? true,
      myRole: myParticipant?.role,
      participants: chat.participants.map((p) => {
        const acc = accountMap.get(p.accountId);
        return {
          participantId: p.id,
          accountId: p.accountId,
          role: p.role,
          name: acc?.name,
          avatar: acc?.avatar,
          isOnline: acc?.isOnline,
          userStatus: acc?.userStatus || acc?.status,
        };
      }),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
  }

  /**
   * Tạo nhóm chat mới
   */
  async createGroupChat(
    userId: string,
    name: string,
    memberIds: string[],
    avatar?: string
  ) {
    if (!name || name.trim().length < 2) {
      throw new Error('Tên nhóm phải có ít nhất 2 ký tự!');
    }

    if (!memberIds || memberIds.length < 1) {
      throw new Error('Vui lòng chọn ít nhất 1 thành viên!');
    }

    // Ensure unique members including creator
    const uniqueMemberIds = [...new Set([userId, ...memberIds])];

    const chat = await prisma.chat.create({
      data: {
        name: name.trim(),
        avatar: avatar || null,
        isGroup: true,
        participants: {
          create: uniqueMemberIds.map((memberId) => ({
            accountId: memberId,
            role: memberId === userId ? 'CHANNEL_OWNER' : 'CHANNEL_MEMBER',
          })),
        },
      },
      include: {
        participants: true,
      },
    });

    // Publish event
    await publishEvent(EventSubjects.GROUP_CREATED, {
      id: chat.id,
      name: chat.name,
      createdBy: userId,
      memberIds: uniqueMemberIds,
      createdAt: chat.createdAt.toISOString(),
    });

    logger.info({ chatId: chat.id, memberCount: uniqueMemberIds.length }, 'Group created');

    return {
      id: chat.id,
      name: chat.name,
      avatar: chat.avatar,
      isGroup: true,
      participants: chat.participants.map((p) => ({
        accountId: p.accountId,
        role: p.role,
      })),
    };
  }

  /**
   * Tìm hoặc tạo chat 1-1
   */
  async getOrCreatePrivateChat(userId: string, partnerId: string) {
    if (userId === partnerId) {
      throw new Error('Không thể chat với chính mình!');
    }

    // Find existing private chat
    const existingChat = await prisma.chat.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { accountId: userId } } },
          { participants: { some: { accountId: partnerId } } },
        ],
      },
      include: {
        participants: true,
      },
    });

    if (existingChat) {
      // Unhide if hidden
      const myParticipant = existingChat.participants.find((p) => p.accountId === userId);
      if (myParticipant?.hidden) {
        await prisma.chatParticipant.update({
          where: { id: myParticipant.id },
          data: { hidden: false },
        });
      }

      return {
        chat: {
          id: existingChat.id,
          isGroup: false,
          partnerId,
        },
        created: false,
      };
    }

    // Create new private chat
    const newChat = await prisma.chat.create({
      data: {
        isGroup: false,
        participants: {
          create: [
            { accountId: userId },
            { accountId: partnerId },
          ],
        },
      },
    });

    return {
      chat: {
        id: newChat.id,
        isGroup: false,
        partnerId,
      },
      created: true,
    };
  }

  /**
   * Cập nhật thông tin nhóm
   */
  async updateChat(chatId: string, userId: string, data: { name?: string; avatar?: string }) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) {
      throw new Error('Không tìm thấy chat!');
    }

    if (!chat.isGroup) {
      throw new Error('Không thể chỉnh sửa chat riêng!');
    }

    // Check leader permission
    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    if (!myParticipant || myParticipant.role !== 'CHANNEL_OWNER') {
      throw new Error('Chỉ chủ sở hữu kênh mới có thể chỉnh sửa!');
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.avatar !== undefined) updateData.avatar = data.avatar;

    const updatedChat = await prisma.chat.update({
      where: { id: chatId },
      data: updateData,
    });

    logger.info({ chatId }, 'Chat updated');

    return updatedChat;
  }

  /**
   * Thêm thành viên vào nhóm
   */
  async addMembers(chatId: string, userId: string, memberIds: string[]) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) {
      throw new Error('Không tìm thấy nhóm!');
    }

    if (!chat.isGroup) {
      throw new Error('Không thể thêm thành viên vào chat riêng!');
    }

    // Check leader permission
    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    if (!myParticipant || myParticipant.role !== 'CHANNEL_OWNER') {
      throw new Error('Chỉ chủ sở hữu kênh mới có thể thêm thành viên!');
    }

    // Filter new members
    const existingMemberIds = chat.participants.map((p) => p.accountId);
    const newMemberIds = memberIds.filter((id) => !existingMemberIds.includes(id));

    if (newMemberIds.length === 0) {
      throw new Error('Tất cả thành viên đã có trong nhóm!');
    }

    // Add new members
    await prisma.chatParticipant.createMany({
      data: newMemberIds.map((memberId) => ({
        chatId,
        accountId: memberId,
        role: 'MEMBER',
      })),
    });

    // Update chat timestamp
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });

    // Publish events
    for (const memberId of newMemberIds) {
      await publishEvent(EventSubjects.GROUP_MEMBER_ADDED, {
        chatId,
        memberId,
        addedBy: userId,
      });
    }

    logger.info({ chatId, addedCount: newMemberIds.length }, 'Members added');

    return { addedCount: newMemberIds.length };
  }

  /**
   * Xóa thành viên khỏi nhóm
   */
  async removeMember(chatId: string, userId: string, memberId: string) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) {
      throw new Error('Không tìm thấy nhóm!');
    }

    if (!chat.isGroup) {
      throw new Error('Không thể xóa thành viên khỏi chat riêng!');
    }

    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    const targetParticipant = chat.participants.find((p) => p.accountId === memberId);

    if (!targetParticipant) {
      throw new Error('Thành viên không có trong nhóm!');
    }

    // Permission check: only leader can remove, or self-leave
    if (userId !== memberId) {
      if (!myParticipant || myParticipant.role !== 'CHANNEL_OWNER') {
        throw new Error('Chỉ chủ sở hữu kênh mới có thể xóa thành viên!');
      }
      if (targetParticipant.role === 'CHANNEL_OWNER') {
        throw new Error('Không thể xóa chủ sở hữu kênh!');
      }
    }

    // Remove participant
    await prisma.chatParticipant.delete({
      where: { id: targetParticipant.id },
    });

    // If leader leaves, transfer to another member
    if (targetParticipant.role === 'CHANNEL_OWNER') {
      const remainingMembers = chat.participants.filter((p) => p.accountId !== memberId);
      if (remainingMembers.length > 0) {
        const newLeader = remainingMembers[0];
        await prisma.chatParticipant.update({
          where: { id: newLeader.id },
          data: { role: 'CHANNEL_OWNER' },
        });
      }
    }

    // Publish event
    await publishEvent(EventSubjects.GROUP_MEMBER_REMOVED, {
      chatId,
      memberId,
      removedBy: userId,
      isSelfLeave: userId === memberId,
    });

    logger.info({ chatId, memberId, isSelfLeave: userId === memberId }, 'Member removed');

    return { isSelfLeave: userId === memberId };
  }

  /**
   * Cập nhật quyền hạn thành viên
   */
  async updateMemberRole(chatId: string, userId: string, memberId: string, newRole: string) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) {
      throw new Error('Không tìm thấy nhóm!');
    }

    if (!chat.isGroup) {
      throw new Error('Không thể phân quyền trong chat riêng!');
    }

    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    const targetParticipant = chat.participants.find((p) => p.accountId === memberId);

    if (!targetParticipant) {
      throw new Error('Thành viên không có trong nhóm!');
    }

    // Permission check: only leader can change roles
    if (!myParticipant || myParticipant.role !== 'CHANNEL_OWNER') {
      throw new Error('Chỉ chủ sở hữu kênh mới có quyền thay đổi quyền hạn!');
    }

    // Cannot change own role if it would leave the group leaderless (guaranteed by current logic)
    // But good to keep it simple: leader can promote others
    
    const updatedParticipant = await prisma.chatParticipant.update({
      where: { id: targetParticipant.id },
      data: { role: newRole as any },
    });

    // Publish event
    await publishEvent(EventSubjects.GROUP_MEMBER_ROLE_UPDATED, {
      chatId,
      memberId,
      newRole,
      updatedBy: userId,
    });

    logger.info({ chatId, memberId, newRole }, 'Member role updated');

    return updatedParticipant;
  }

  /**
   * Ghim/bỏ ghim chat
   */
  async togglePin(chatId: string, userId: string, pin?: boolean) {
    const participant = await prisma.chatParticipant.findFirst({
      where: { chatId, accountId: userId },
    });

    if (!participant) {
      throw new Error('Không tìm thấy chat!');
    }

    const newPin = pin ?? !participant.pin;

    await prisma.chatParticipant.update({
      where: { id: participant.id },
      data: { pin: newPin },
    });

    return { pin: newPin };
  }

  /**
   * Bật/tắt thông báo
   */
  async toggleNotify(chatId: string, userId: string, notify?: boolean) {
    const participant = await prisma.chatParticipant.findFirst({
      where: { chatId, accountId: userId },
    });

    if (!participant) {
      throw new Error('Không tìm thấy chat!');
    }

    const newNotify = notify ?? !participant.notify;

    await prisma.chatParticipant.update({
      where: { id: participant.id },
      data: { notify: newNotify },
    });

    return { notify: newNotify };
  }

  /**
   * Đánh dấu đã đọc
   */
  async markAsRead(chatId: string, userId: string) {
    const participant = await prisma.chatParticipant.findFirst({
      where: { chatId, accountId: userId },
    });

    if (!participant) {
      throw new Error('Không tìm thấy chat!');
    }

    await prisma.chatParticipant.update({
      where: { id: participant.id },
      data: { readed: true },
    });

    // Cập nhật Read Receipt bên chat-service để reset unreadCount
    try {
        let CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL;
        if (!CHAT_SERVICE_URL) {
          const userorgUrl = process.env.USERORG_SERVICE_URL || '';
          CHAT_SERVICE_URL = userorgUrl.includes('userorg-service') 
            ? 'http://chat-service:3013' 
            : 'http://localhost:3013';
        }
        
        // Gọi chat-service/chats/:chatId/read
        const url = `${CHAT_SERVICE_URL}/chats/${chatId}/read`;
        console.log(`[ChatService] Calling chat-service: ${url} for user: ${userId}`);
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-user-id': userId 
          },
          body: JSON.stringify({}) // messageId optional, tự lấy tin mới nhất
        });
        
        if (!response.ok) {
           console.error(`[ChatService] Sync read status failed with status: ${response.status}`);
        } else {
           console.log(`[ChatService] Sync read status success for chat: ${chatId}`);
        }
    } catch (err) {
        console.error('[ChatService] Failed to notify chat-service about markAsRead', err);
    }

    // Publish event
    await publishEvent(EventSubjects.MESSAGE_READ, {
      chatId,
      userId,
      readAt: new Date().toISOString(),
    });
  }

  /**
   * Xóa chat
   */
  async deleteChat(chatId: string, userId: string) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) {
      throw new Error('Không tìm thấy chat!');
    }

    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    if (!myParticipant) {
      throw new Error('Bạn không có quyền!');
    }

    // Private chat: soft delete (hide)
    if (!chat.isGroup) {
      await prisma.chatParticipant.update({
        where: { id: myParticipant.id },
        data: { hidden: true },
      });

      return { type: 'soft_delete' };
    }

    // Group chat: only leader can hard delete
    if (myParticipant.role !== 'CHANNEL_OWNER') {
      throw new Error('Chỉ chủ sở hữu kênh mới có thể xóa kênh!');
    }

    // Get members before deleting to notify them
    const memberIds = chat.participants.map(p => p.accountId);

    await prisma.chat.delete({ where: { id: chatId } });

    // Publish event
    await publishEvent(EventSubjects.GROUP_DELETED, {
      chatId,
      memberIds,
      deletedBy: userId,
    });

    logger.info({ chatId }, 'Group deleted');

    return { type: 'hard_delete' };
  }
  /**
   * Lấy danh sách participant IDs cho ws-gateway fan-out (internal use only)
   */
  async getParticipantIds(chatId: string): Promise<string[]> {
    const participants = await prisma.chatParticipant.findMany({
      where: { chatId, hidden: false },
      select: { accountId: true },
    });
    return participants.map((p: { accountId: string }) => p.accountId);
  }

  /**
   * Lấy metadata chat (internal use)
   */
  async getChatMetadataInternal(chatId: string) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        isGroup: true,
        participants: {
          select: {
            accountId: true,
          },
        },
      },
    });
    return chat;
  }
}

export const chatService = new ChatService();
