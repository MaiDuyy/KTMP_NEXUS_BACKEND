// services/messaging-service/src/services/chat.service.ts
// Unified from group-service/src/services/chat.service.ts
// KEY CHANGE: No longer calls chat-service via HTTP for summaries — uses direct Prisma queries

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { messageService } from './message.service.js';
import { userorgClient } from '../lib/userorgClient.js';
export class ChatService {
  /**
   * Lấy danh sách chat của user
   */
  async getChats(userId: string, type?: 'all' | 'private' | 'group', workspaceId?: string) {
    const whereCondition: any = {
      participants: {
        some: {
          accountId: userId,
          hidden: false,
        },
      },
      workspaceId: workspaceId || null, // Phân tách chat theo workspace
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

    // Get user details from userorg-service via userorgClient (Redis Cache + Batching)
    const uniqueAccountIds = [...new Set(chats.flatMap(c => c.participants.map(p => p.accountId)))];
    const accountMap = await userorgClient.getUsers(uniqueAccountIds);

    // DIRECT CALL: Get summaries from message service (no more HTTP to chat-service)
    let summaryMap = new Map<string, any>();
    if (chats.length > 0) {
      try {
        const chatIds = chats.map(c => c.id);
        const summary = await messageService.getChatSummary(userId, chatIds);
        summary.forEach((item: any) => summaryMap.set(item.chatId, item));
      } catch (err) {
        console.error('[ChatService] Failed to get chat summaries', err);
      }
    }

    // Format response
    const formattedChats = await Promise.all(chats.map(async (chat) => {
      const myParticipant = chat.participants.find((p) => p.accountId === userId);
      const otherParticipants = chat.participants.filter((p) => p.accountId !== userId);
      
      const summary = summaryMap.get(chat.id);

      // Check if blocked and friendship (for private chats)
      let isBlocked = false;
      let isBlockedByMe = false;
      let isFriend = false;
      if (!chat.isGroup && otherParticipants.length > 0) {
        try {
          const partnerId = otherParticipants[0].accountId;
          const blockInfo = await userorgClient.checkBlockedStatus(userId, partnerId);
          isBlocked = blockInfo.isBlocked;
          isBlockedByMe = blockInfo.isBlocked && blockInfo.blockerId === userId;
          
          isFriend = await userorgClient.checkFriendship(userId, partnerId);
        } catch (err) {
          console.error('[ChatService] Failed to check block status in list', err);
        }
      }
    
      return {
        id: chat.id,
        name: chat.name,
        avatar: chat.avatar,
        isGroup: chat.isGroup,
        joinPolicy: chat.joinPolicy,
        isBlocked,
        isBlockedByMe,
        isFriend,
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

    const uniqueAccountIds = [...new Set(chat.participants.map(p => p.accountId))];
    const accountMap = await userorgClient.getUsers(uniqueAccountIds);

    // Check if blocked and friendship (for private chats)
    let isBlocked = false;
    let isBlockedByMe = false;
    let isFriend = false;
    if (!chat.isGroup) {
      const partner = chat.participants.find(p => p.accountId !== userId);
      if (partner) {
        try {
          const blockInfo = await userorgClient.checkBlockedStatus(userId, partner.accountId);
          isBlocked = blockInfo.isBlocked;
          isBlockedByMe = blockInfo.isBlocked && blockInfo.blockerId === userId;

          isFriend = await userorgClient.checkFriendship(userId, partner.accountId);
        } catch (error) {
          console.error('[ChatService] Error checking blocked status:', error);
        }
      }
    }

    // Get join requests if admin
    let joinRequests: any[] = [];
    if (chat.isGroup && (myParticipant?.role === 'CHANNEL_OWNER' || myParticipant?.role === 'CHANNEL_MODERATOR')) {
      const pendingRequests = await prisma.joinRequest.findMany({
        where: { chatId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });

      if (pendingRequests.length > 0) {
        const requestAccountIds = pendingRequests.map(r => r.accountId);
        const requestAccountMap = await userorgClient.getUsers(requestAccountIds);
        joinRequests = pendingRequests.map(r => ({
          ...r,
          account: requestAccountMap.get(r.accountId)
        }));
      }
    }

    return {
      id: chat.id,
      name: chat.name,
      avatar: chat.avatar,
      isGroup: chat.isGroup,
      joinPolicy: chat.joinPolicy,
      joinRequests,
      isBlocked,
      isBlockedByMe,
      isFriend,
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

  async createGroupChat(
    userId: string,
    name: string,
    memberIds: string[],
    options?: { avatar?: string; joinPolicy?: 'PUBLIC' | 'PRIVATE' | 'APPROVAL' },
    workspaceId?: string
  ) {
    if (!name || name.trim().length < 2) {
      throw new Error('Tên nhóm phải có ít nhất 2 ký tự!');
    }

    const uniqueMemberIds = [...new Set([userId, ...(memberIds || [])])];

    // RBAC Check for Workspace
    if (workspaceId) {
      const workspaceMember = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } }
      });
      
      if (!workspaceMember) {
        throw new Error('Bạn không phải là thành viên của Workspace này!');
      }

      if (workspaceMember.role === 'WORKSPACE_GUEST') {
        throw new Error('Khách (Guest) không có quyền tạo nhóm chat mới trong Workspace!');
      }
      // Ensure all members belong to the workspace
      const workspaceMembers = await prisma.workspaceMember.findMany({
        where: { workspaceId, userId: { in: uniqueMemberIds } },
        select: { userId: true }
      });
      const inWorkspaceIds = workspaceMembers.map(m => m.userId);
      const invalidIds = uniqueMemberIds.filter(id => !inWorkspaceIds.includes(id));
      if (invalidIds.length > 0) {
        throw new Error('Một số thành viên được chọn không thuộc Workspace này!');
      }
    }

    const chat = await prisma.chat.create({
      data: {
        name: name.trim(),
        avatar: options?.avatar || null,
        isGroup: true,
        joinPolicy: options?.joinPolicy || 'PUBLIC',
        workspaceId: workspaceId || null,
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
      joinPolicy: chat.joinPolicy,
      createdAt: chat.createdAt.toISOString(),
    });

    logger.info({ chatId: chat.id, memberCount: uniqueMemberIds.length }, 'Group created');

    // System Message: Created group
    try {
      const accountMap = await userorgClient.getUsers([userId]);
      const userName = accountMap.get(userId)?.name || 'Người dùng';
      await messageService.sendMessage(chat.id, userId, {
        content: `${userName} đã tạo nhóm ${chat.name}`,
        type: 'system'
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to send system message for group creation');
    }

    return {
      id: chat.id,
      name: chat.name,
      avatar: chat.avatar,
      isGroup: true,
      joinPolicy: chat.joinPolicy,
      participants: chat.participants.map((p) => ({
        accountId: p.accountId,
        role: p.role,
      })),
      myRole: 'CHANNEL_OWNER',
    };
  }

  /**
   * Tìm hoặc tạo chat 1-1
   */
  async getOrCreatePrivateChat(userId: string, partnerId: string, workspaceId?: string) {
    if (userId === partnerId) {
      throw new Error('Không thể chat với chính mình!');
    }

    const existingChat = await prisma.chat.findFirst({
      where: {
        isGroup: false,
        workspaceId: workspaceId || null,
        AND: [
          { participants: { some: { accountId: userId } } },
          { participants: { some: { accountId: partnerId } } },
        ],
      },
      include: {
        participants: true,
      },
    });

    if (workspaceId) {
      // Verify partner is in workspace
      const partnerInWorkspace = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: partnerId } }
      });
      if (!partnerInWorkspace) {
        throw new Error('Người nhận không thuộc Workspace này!');
      }
    }

    if (existingChat) {
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

    const newChat = await prisma.chat.create({
      data: {
        isGroup: false,
        workspaceId: workspaceId || null,
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

  async updateChat(chatId: string, userId: string, data: { name?: string; avatar?: string; joinPolicy?: any }) {
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

    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    // RBAC: Owner (CHANNEL_OWNER) or Moderator (CHANNEL_MODERATOR) can update info
    if (!myParticipant || (myParticipant.role !== 'CHANNEL_OWNER' && myParticipant.role !== 'CHANNEL_MODERATOR')) {
      throw new Error('Bạn không có quyền chỉnh sửa thông tin nhóm!');
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.avatar !== undefined) updateData.avatar = data.avatar;
    if (data.joinPolicy !== undefined) {
      // Only Owner can change join policy
      if (myParticipant.role !== 'CHANNEL_OWNER') {
        throw new Error('Chỉ nhóm trưởng mới có thể thay đổi chế độ tham gia!');
      }
      updateData.joinPolicy = data.joinPolicy;
    }

    const updatedChat = await prisma.chat.update({
      where: { id: chatId },
      data: updateData,
    });

    await publishEvent(EventSubjects.GROUP_UPDATED, {
      chatId,
      updatedBy: userId,
      data: updateData
    });

    logger.info({ chatId }, 'Chat updated');

    // System Message: Info updated
    try {
      const accountMap = await userorgClient.getUsers([userId]);
      const hostName = accountMap.get(userId)?.name || 'Người dùng';
      
      if (data.name) {
        await messageService.sendMessage(chatId, userId, {
          content: `${hostName} đã đổi tên nhóm thành "${data.name}"`,
          type: 'system'
        });
      }
      if (data.joinPolicy) {
        const policyLabel = data.joinPolicy === 'PUBLIC' ? 'Công khai' : data.joinPolicy === 'APPROVAL' ? 'Phê duyệt' : 'Riêng tư';
        await messageService.sendMessage(chatId, userId, {
          content: `${hostName} đã đổi chế độ tham gia thành "${policyLabel}"`,
          type: 'system'
        });
      }
    } catch (e) {
      logger.error({ err: e }, 'Failed to send system message for group update');
    }

    return {
      id: updatedChat.id,
      name: updatedChat.name,
      avatar: updatedChat.avatar,
      isGroup: updatedChat.isGroup,
      joinPolicy: updatedChat.joinPolicy,
    };
  }

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

    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    // RBAC: Owner or Deputy can add members
    if (!myParticipant || (myParticipant.role !== 'CHANNEL_OWNER' && myParticipant.role !== 'CHANNEL_MODERATOR')) {
      throw new Error('Bạn không có quyền thêm thành viên!');
    }

        if (chat.workspaceId) {
      // Ensure added members belong to the workspace
      const workspaceMembers = await prisma.workspaceMember.findMany({
        where: { workspaceId: chat.workspaceId, userId: { in: memberIds } },
        select: { userId: true }
      });
      const inWorkspaceIds = workspaceMembers.map(m => m.userId);
      const invalidIds = memberIds.filter(id => !inWorkspaceIds.includes(id));
      if (invalidIds.length > 0) {
        throw new Error('Một số thành viên được chọn không thuộc Workspace này!');
      }
    }
    const existingMemberIds = chat.participants.map((p) => p.accountId);
    const newMemberIds = memberIds.filter((id) => !existingMemberIds.includes(id));

    if (newMemberIds.length === 0) {
      throw new Error('Tất cả thành viên đã có trong nhóm!');
    }

    await prisma.chatParticipant.createMany({
      data: newMemberIds.map((memberId) => ({
        chatId,
        accountId: memberId,
        role: 'CHANNEL_MEMBER' as const,
      })),
    });

    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });

    for (const memberId of newMemberIds) {
      await publishEvent(EventSubjects.GROUP_MEMBER_ADDED, {
        chatId,
        memberId,
        addedBy: userId,
      });
    }

    logger.info({ chatId, addedCount: newMemberIds.length }, 'Members added');

    // System Message: Added members
    try {
      const accountIds = [userId, ...newMemberIds];
      const accountMap = await userorgClient.getUsers(accountIds);
      const hostName = accountMap.get(userId)?.name || 'Người dùng';
      const invitedNames = newMemberIds.map(id => accountMap.get(id)?.name || 'Người dùng').join(', ');
      await messageService.sendMessage(chatId, userId, {
        content: `${hostName} đã thêm ${invitedNames} vào nhóm`,
        type: 'system'
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to send system message for adding members');
    }

    return { addedCount: newMemberIds.length };
  }

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

    // RBAC: 
    // 1. Self leave is always allowed
    // 2. Owner can kick anyone
    // 3. Deputy can kick Member (not Owner/Deputy)
    if (userId !== memberId) {
      if (!myParticipant) throw new Error('Bạn không có quyền!');

      if (myParticipant.role === 'CHANNEL_OWNER') {
        if (targetParticipant.role === 'CHANNEL_OWNER') throw new Error('Không thể xóa chính mình qua hàm này, hãy dùng chuyển quyền!');
      } else if (myParticipant.role === 'CHANNEL_MODERATOR') {
        if (targetParticipant.role === 'CHANNEL_OWNER' || targetParticipant.role === 'CHANNEL_MODERATOR') {
          throw new Error('Nhóm phó không thể xóa Trưởng nhóm hoặc Nhóm phó khác!');
        }
      } else {
        throw new Error('Thành viên không có quyền xóa người khác!');
      }
    }

    await prisma.chatParticipant.delete({
      where: { id: targetParticipant.id },
    });

    // If Owner leaves, transfer to someone else
    if (userId === memberId && targetParticipant.role === 'CHANNEL_OWNER') {
      const remainingMembers = chat.participants.filter((p) => p.accountId !== memberId);
      if (remainingMembers.length > 0) {
        // Prefer Deputy if exists
        const nextLeader = remainingMembers.find(p => p.role === 'CHANNEL_MODERATOR') || remainingMembers[0];
        await prisma.chatParticipant.update({
          where: { id: nextLeader.id },
          data: { role: 'CHANNEL_OWNER' },
        });
      }
    }

    await publishEvent(EventSubjects.GROUP_MEMBER_REMOVED, {
      chatId,
      memberId,
      removedBy: userId,
      isSelfLeave: userId === memberId,
    });

    logger.info({ chatId, memberId, isSelfLeave: userId === memberId }, 'Member removed');

    // System Message: Removed member
    try {
      const accountIds = userId === memberId ? [userId] : [userId, memberId];
      const accountMap = await userorgClient.getUsers(accountIds);
      const hostName = accountMap.get(userId)?.name || 'Người dùng';
      const targetName = accountMap.get(memberId)?.name || 'Người dùng';

      const content = userId === memberId 
        ? `${hostName} đã rời khỏi nhóm` 
        : `${hostName} đã xóa ${targetName} khỏi nhóm`;

      await messageService.sendMessage(chatId, userId, {
        content,
        type: 'system'
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to send system message for member removal');
    }

    return { isSelfLeave: userId === memberId };
  }

  async updateMemberRole(chatId: string, userId: string, memberId: string, newRole: string) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) {
      throw new Error('Không tìm thấy nhóm!');
    }

    const myParticipant = chat.participants.find((p) => p.accountId === userId);
    const targetParticipant = chat.participants.find((p) => p.accountId === memberId);

    if (!targetParticipant) {
      throw new Error('Thành viên không có trong nhóm!');
    }

    // RBAC: Only CHANNEL_OWNER can manage roles (CHANNEL_OWNER or CHANNEL_MODERATOR)
    if (!myParticipant || myParticipant.role !== 'CHANNEL_OWNER') {
      throw new Error('Chỉ nhóm trưởng mới có quyền thay đổi vai trò!');
    }

    if (newRole === 'CHANNEL_OWNER') {
      // Transfer Ownership
      await prisma.$transaction([
        prisma.chatParticipant.update({
          where: { id: myParticipant.id },
          data: { role: 'CHANNEL_MODERATOR' }, // Demote current leader to deputy
        }),
        prisma.chatParticipant.update({
          where: { id: targetParticipant.id },
          data: { role: 'CHANNEL_OWNER' },
        }),
      ]);
    } else {
      await prisma.chatParticipant.update({
        where: { id: targetParticipant.id },
        data: { role: newRole as any },
      });
    }

    await publishEvent(EventSubjects.GROUP_MEMBER_ROLE_UPDATED, {
      chatId,
      memberId,
      newRole,
      updatedBy: userId,
    });

    logger.info({ chatId, memberId, newRole }, 'Member role updated');

    // System Message: Role update
    try {
      const accountIds = [userId, memberId];
      const accountMap = await userorgClient.getUsers(accountIds);
      const hostName = accountMap.get(userId)?.name || 'Người dùng';
      const targetName = accountMap.get(memberId)?.name || 'Người dùng';
      
      const roleLabel = newRole === 'CHANNEL_OWNER' ? 'Trưởng nhóm' : newRole === 'CHANNEL_MODERATOR' ? 'Phó nhóm' : 'Thành viên';
      const content = newRole === 'CHANNEL_OWNER' 
        ? `${hostName} đã chuyển quyền Trưởng nhóm cho ${targetName}` 
        : `${hostName} đã đặt quyền ${roleLabel} cho ${targetName}`;

      await messageService.sendMessage(chatId, userId, {
        content,
        type: 'system'
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to send system message for role update');
    }

    return { success: true };
  }

  /**
   * Gửi yêu cầu tham gia nhóm hoặc tham gia trực tiếp nếu public
   */
  async joinGroup(chatId: string, userId: string) {
    console.log(`[ChatService] User ${userId} joining group ${chatId}`);
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat || !chat.isGroup) throw new Error('Nhóm không tồn tại!');
    
    const isMember = chat.participants.some(p => p.accountId === userId);
    if (isMember) throw new Error('Bạn đã là thành viên nhóm này!');

    if (chat.joinPolicy === 'PUBLIC') {
      await prisma.chatParticipant.create({
        data: {
          chatId,
          accountId: userId,
          role: 'CHANNEL_MEMBER',
        },
      });
      
      await publishEvent(EventSubjects.GROUP_MEMBER_ADDED, {
        chatId,
        memberId: userId,
        addedBy: 'SYSTEM_PUBLIC_JOIN',
      });
      
      return { status: 'JOINED' };
    } else if (chat.joinPolicy === 'APPROVAL') {
      const request = await prisma.joinRequest.upsert({
        where: { chatId_accountId: { chatId, accountId: userId } },
        update: { status: 'PENDING' },
        create: { chatId, accountId: userId },
      });

      await publishEvent(EventSubjects.GROUP_JOIN_REQUEST_CREATED, {
        chatId,
        accountId: userId,
        requestId: request.id
      });

      return { status: 'REQUEST_SENT' };
    } else {
      throw new Error('Nhóm này là riêng tư, cần được mời để tham gia!');
    }
  }

  /**
   * Duyệt yêu cầu tham gia
   */
  async approveJoinRequest(chatId: string, userId: string, targetAccountId: string, approve: boolean) {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) throw new Error('Nhóm không tồn tại!');
    
    const myParticipant = chat.participants.find(p => p.accountId === userId);
    if (!myParticipant || (myParticipant.role !== 'CHANNEL_OWNER' && myParticipant.role !== 'CHANNEL_MODERATOR')) {
      throw new Error('Bạn không có quyền duyệt yêu cầu!');
    }

    const request = await prisma.joinRequest.findUnique({
      where: { chatId_accountId: { chatId, accountId: targetAccountId } }
    });

    if (!request || request.status !== 'PENDING') throw new Error('Yêu cầu không hợp lệ!');

    if (approve) {
      await prisma.$transaction([
        prisma.joinRequest.update({
          where: { id: request.id },
          data: { status: 'APPROVED' }
        }),
        prisma.chatParticipant.create({
          data: { chatId, accountId: targetAccountId, role: 'CHANNEL_MEMBER' }
        })
      ]);

      await publishEvent(EventSubjects.GROUP_MEMBER_ADDED, {
        chatId,
        memberId: targetAccountId,
        addedBy: userId
      });
    } else {
      await prisma.joinRequest.update({
        where: { id: request.id },
        data: { status: 'REJECTED' }
      });
    }

    await publishEvent(EventSubjects.GROUP_JOIN_REQUEST_UPDATED, {
      chatId,
      accountId: targetAccountId,
      status: approve ? 'APPROVED' : 'REJECTED',
      handledBy: userId
    });

    // System Message: Join request handled
    try {
      const accountIds = [userId, targetAccountId];
      const accountMap = await userorgClient.getUsers(accountIds);
      const hostName = accountMap.get(userId)?.name || 'Người dùng';
      const targetName = accountMap.get(targetAccountId)?.name || 'Người dùng';

      if (approve) {
        await messageService.sendMessage(chatId, userId, {
          content: `${hostName} đã duyệt yêu cầu tham gia của ${targetName}`,
          type: 'system'
        });
      }
    } catch (e) {
      logger.error({ err: e }, 'Failed to send system message for join request approval');
    }

    return { success: true };
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

  async getReadReceipts(chatId: string) {
    const { readReceiptService } = await import('./readreceipt.service.js');
    return readReceiptService.getReadReceipts(chatId);
  }

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

    try {
      const { readReceiptService } = await import('./readreceipt.service.js');
      await readReceiptService.markAsRead(chatId, userId);
    } catch (err) {
      console.error('[ChatService] Failed to update read receipt', err);
    }

    // Restore the publish event!
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
      throw new Error('Chỉ nhóm trưởng mới có thể xóa nhóm!');
    }

    const memberIds = chat.participants.map(p => p.accountId);

    await prisma.chat.delete({ where: { id: chatId } });

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
      include: {
        participants: {
          select: { accountId: true }
        }
      }
    });
    if (!chat) return null;
    return {
      ...chat,
      participantCount: chat.participants.length
    };
  }
}

export const chatService = new ChatService();
