// services/messaging-service/src/services/message.service.ts
// KEY REFACTOR: Removed groupClient HTTP dependency — now queries Chat/ChatParticipant directly via Prisma

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { userorgClient } from '../lib/userorgClient.js';
import { mentionService } from './mention.service.js';
import { hasChatAccess } from '../middleware/chatAccess.js';


const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'file', 'sticker', 'gif', 'location', 'contact', 'system', 'call_started', 'call_participant_joined', 'call_participant_left', 'call_ended', 'call_missed', 'call_declined', 'call_cancelled', 'poll', 'task'];

export class MessageService {
  async getMessages(
    chatId: string,
    userId: string,
    options: { cursor?: string; limit?: number }
  ) {
    const { cursor, limit = 50 } = options;
    const take = Math.min(limit, 100);

    const participant = await prisma.chatParticipant.findUnique({
      where: { chatId_accountId: { chatId, accountId: userId } },
      select: { clearedAt: true }
    });
    const clearedAt = participant?.clearedAt;

    const whereCondition: any = {
      chatId,
      OR: [
        { deletedBy: null },
        { NOT: { deletedBy: { contains: userId } } },
      ],
    };

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!isNaN(cursorDate.getTime())) {
        whereCondition.time = { lt: cursorDate };
      }
    }

    if (clearedAt) {
      if (whereCondition.time) {
        whereCondition.time.gt = clearedAt;
      } else {
        whereCondition.time = { gt: clearedAt };
      }
    }

    const messages = await prisma.message.findMany({
      where: whereCondition,
      include: {
        replyTo: {
          select: { id: true, content: true, type: true, senderId: true },
        },
        reactions: true,
      },
      orderBy: { time: 'desc' },
      take,
    });

    const hydratedMessages = await this.populateSenderInfo(messages, chatId);

    const formattedMessages = hydratedMessages.map((msg) => ({
      id: msg.id,
      content: msg.content,
      type: msg.type,
      time: msg.time,
      pin: msg.pin,
      senderId: msg.senderId,
      sender: msg.sender,
      replyTo: msg.replyTo
        ? { 
            id: msg.replyTo.id, 
            content: msg.replyTo.content, 
            type: msg.replyTo.type, 
            senderId: msg.replyTo.senderId,
            sender: msg.replyTo.sender
          }
        : null,
      file: msg.fileName
        ? { name: msg.fileName, size: msg.fileSize, type: msg.fileType }
        : null,
      reactions: this.groupReactions(msg.reactions),
      destroy: msg.destroy,
      isMe: msg.senderId === userId,
    }));

    const lastMessage = messages[messages.length - 1];

    // Ensure nextCursor is always a valid ISO string, never a raw Date or "Invalid Date"
    let nextCursor: string | null = null;
    if (messages.length === take && lastMessage?.time instanceof Date && !isNaN(lastMessage.time.getTime())) {
      nextCursor = lastMessage.time.toISOString();
    }

    return {
      messages: formattedMessages.reverse(),
      nextCursor,
    };
  }

  async sendMessage(
    chatId: string,
    senderId: string,
    input: {
      content?: string;
      type?: string;
      replyToId?: string;
      fileName?: string;
      fileSize?: string;
      fileType?: string;
    }
  ) {
    const { content, type = 'text', replyToId, fileName, fileSize, fileType } = input;

    // REFACTORED: Direct Prisma query instead of HTTP to group-service
    let workspaceId: string | null = null;
    let participantIds: string[] = [];
    let chatMetadata: any = null;

    // Trusted internal types (system, call_*): fetch participantIds for real-time push
    // but skip all send-permission validations (block check, readonly, participant check, etc.)
    const INTERNAL_TYPES = ['system', 'call_started', 'call_ended', 'call_missed', 'call_declined', 'call_cancelled', 'call_participant_joined', 'call_participant_left'];
    const isInternalType = INTERNAL_TYPES.includes(type);

    if (isInternalType && chatId) {
      const internalChatMeta = await prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          workspaceId: true,
          participants: { select: { accountId: true } },
        },
      });
      if (internalChatMeta) {
        workspaceId = internalChatMeta.workspaceId;
        participantIds = internalChatMeta.participants.map((p: any) => p.accountId);
      }
    }

    if (!isInternalType && chatId) {
      chatMetadata = await prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          id: true,
          isGroup: true,
          name: true,
          workspaceId: true,
          isReadOnly: true,
          participants: { select: { accountId: true, role: true } },
        },
      });

      if (chatMetadata) {
        workspaceId = chatMetadata.workspaceId;
        participantIds = chatMetadata.participants.map((p: any) => p.accountId);

        // Filter out participants who are not active workspace members if this is a workspace-scoped chat
        if (workspaceId) {
          try {
            const activeMembers = await prisma.workspaceMember.findMany({
              where: {
                workspaceId,
                userId: { in: participantIds },
                leftAt: null,
              },
              select: { userId: true },
            });
            const activeMemberIds = new Set(activeMembers.map(m => m.userId));
            participantIds = participantIds.filter(id => activeMemberIds.has(id));
          } catch (e) {
            logger.warn({ workspaceId }, 'Failed to filter message participants by workspace membership');
          }
        }

        // Check Read-only permission
        if (chatMetadata.isReadOnly) {
          const userParticipant = chatMetadata.participants.find((p: any) => p.accountId === senderId);
          const privilegedRoles = ['CHANNEL_OWNER', 'CHANNEL_MODERATOR', 'WORKSPACE_ADMIN', 'WORKSPACE_OWNER'];
          
          if (!userParticipant || !privilegedRoles.includes(userParticipant.role)) {
            // Check if user is Workspace Admin/Owner (might not be in participants list but has access to public channel)
            let isWorkspacePrivileged = false;
            if (workspaceId) {
                try {
                    const workspaceMember = await prisma.workspaceMember.findUnique({
                        where: { workspaceId_userId: { workspaceId, userId: senderId } },
                        select: { role: true, leftAt: true }
                    });
                    // Must be an ACTIVE admin/owner (not left/kicked)
                    if (workspaceMember && workspaceMember.leftAt === null &&
                        (workspaceMember.role === 'WORKSPACE_ADMIN' || workspaceMember.role === 'WORKSPACE_OWNER')) {
                        isWorkspacePrivileged = true;
                    }
                } catch (e) {
                    logger.warn({ senderId, workspaceId }, 'Failed to check workspace member role');
                }
            }

            if (!isWorkspacePrivileged) {
                throw new Error('Kênh này đang ở chế độ chỉ đọc. Chỉ quản trị viên mới có thể gửi tin nhắn.');
            }
          }
        }

        if (!chatMetadata.isGroup) {
          const partner = chatMetadata.participants.find((p: any) => p.accountId !== senderId);

          if (partner) {
            const blockInfo = await userorgClient.checkBlockedStatus(senderId, partner.accountId);
            if (blockInfo.isBlocked) {
              throw new Error('Bạn không thể gửi tin nhắn cho người này vì đã bị chặn hoặc bạn đã chặn người này!');
            }

            // For workspace-scoped private DMs, verify both participants are still active workspace members
            if (workspaceId) {
              try {
                const activeMembers = await prisma.workspaceMember.findMany({
                  where: {
                    workspaceId,
                    userId: { in: [senderId, partner.accountId] },
                    leftAt: null,
                  },
                  select: { userId: true },
                });
                const activeMemberIds = activeMembers.map(m => m.userId);
                if (!activeMemberIds.includes(senderId)) {
                  throw new Error('Bạn không còn là thành viên của không gian làm việc này!');
                }
                if (!activeMemberIds.includes(partner.accountId)) {
                  throw new Error('Thành viên này đã rời khỏi không gian làm việc!');
                }
              } catch (e: any) {
                if (e.message?.includes('rời khỏi') || e.message?.includes('không còn là')) {
                  throw e;
                }
                logger.warn({ workspaceId }, 'Failed to check workspace membership during sendMessage');
              }
            }
          }
        }
      }
    }

    if (!MESSAGE_TYPES.includes(type)) {
      throw new Error('Loại tin nhắn không hợp lệ!');
    }

    if (type === 'text' && (!content || content.trim().length === 0)) {
      throw new Error('Nội dung tin nhắn không được trống!');
    }

    if (replyToId) {
      const replyMessage = await prisma.message.findFirst({
        where: { id: replyToId, chatId },
      });
      if (!replyMessage) {
        throw new Error('Tin nhắn reply không tồn tại!');
      }
    }

    const message = await prisma.message.create({
      data: {
        id: uuidv4(),
        chatId,
        senderId,
        content: content?.trim() || null,
        type,
        replyToId: replyToId || null,
        fileName: fileName || null,
        fileSize: fileSize || null,
        fileType: fileType || null,
      },
      include: {
        replyTo: {
          select: { id: true, content: true, type: true, senderId: true },
        },
      },
    });

    // Unhide chat for all participants so it reappears in their chat list on new activity
    await prisma.chatParticipant.updateMany({
      where: { chatId, hidden: true },
      data: { hidden: false },
    }).catch(() => {});

    const accountIdsToFetch = [senderId];
    if (message.replyTo?.senderId) {
      accountIdsToFetch.push(message.replyTo.senderId);
    }

    let senderProfile = null;
    let replySenderProfile = null;
    try {
      const accountMap = await userorgClient.getUsers(accountIdsToFetch);
      senderProfile = accountMap.get(senderId);
      if (message.replyTo?.senderId) {
        replySenderProfile = accountMap.get(message.replyTo.senderId);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch user profiles for new message');
    }

    // Determine roles for sender and replyTo.sender
    let senderRole = 'EMPLOYEE';
    let replySenderRole = 'EMPLOYEE';

    if (senderProfile?.role === 'SUPER_ADMIN') {
      senderRole = 'SUPER_ADMIN';
    } else if (senderProfile?.role === 'ADMIN') {
      senderRole = 'SYSTEM_ADMIN';
    } else if (senderProfile?.role === 'WORKSPACE_MANAGER') {
      senderRole = 'WORKSPACE_MANAGER';
    }

    if (replySenderProfile?.role === 'SUPER_ADMIN') {
      replySenderRole = 'SUPER_ADMIN';
    } else if (replySenderProfile?.role === 'ADMIN') {
      replySenderRole = 'SYSTEM_ADMIN';
    } else if (replySenderProfile?.role === 'WORKSPACE_MANAGER') {
      replySenderRole = 'WORKSPACE_MANAGER';
    }

    if (workspaceId) {
      try {
        const workspace = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { departmentId: true }
        });
        const departmentId = workspace?.departmentId || null;

        // 1. Resolve sender role
        if (senderRole === 'EMPLOYEE') {
          const wMember = await prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: senderId } },
            select: { role: true, leftAt: true }
          });
          if (wMember && wMember.leftAt === null && ['WORKSPACE_ADMIN', 'WORKSPACE_OWNER'].includes(wMember.role)) {
            senderRole = 'WORKSPACE_ADMIN';
          } else if (wMember && wMember.leftAt === null && departmentId) {
            const deptHeads = await prisma.$queryRaw<any[]>`
              SELECT "role" 
              FROM rbac.department_member 
              WHERE "departmentId" = ${departmentId} 
                AND "userId" = ${senderId}
                AND "role" IN ('HEAD', 'MANAGER')
            `;
            if (Array.isArray(deptHeads) && deptHeads.length > 0) {
              senderRole = 'DEPARTMENT_HEAD';
            }
          }
        }

        // 2. Resolve reply sender role if applicable
        if (message.replyTo?.senderId && replySenderRole === 'EMPLOYEE') {
          const rMember = await prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: message.replyTo.senderId } },
            select: { role: true, leftAt: true }
          });
          if (rMember && rMember.leftAt === null && ['WORKSPACE_ADMIN', 'WORKSPACE_OWNER'].includes(rMember.role)) {
            replySenderRole = 'WORKSPACE_ADMIN';
          } else if (rMember && rMember.leftAt === null && departmentId) {
            const rDeptHeads = await prisma.$queryRaw<any[]>`
              SELECT "role" 
              FROM rbac.department_member 
              WHERE "departmentId" = ${departmentId} 
                AND "userId" = ${message.replyTo.senderId}
                AND "role" IN ('HEAD', 'MANAGER')
            `;
            if (Array.isArray(rDeptHeads) && rDeptHeads.length > 0) {
              replySenderRole = 'DEPARTMENT_HEAD';
            }
          }
        }
      } catch (e) {
        logger.warn({ e, workspaceId }, 'Failed to resolve roles for sendMessage');
      }
    }

    const senderPayload = senderProfile ? {
      id: senderProfile.id,
      name: senderProfile.name,
      avatar: senderProfile.avatar,
      role: senderRole,
    } : undefined;

    const replySenderPayload = replySenderProfile ? {
      id: replySenderProfile.id,
      name: replySenderProfile.name,
      avatar: replySenderProfile.avatar,
      role: replySenderRole,
    } : undefined;

    const replyToPayload = message.replyTo ? {
      id: message.replyTo.id,
      content: message.replyTo.content,
      type: message.replyTo.type,
      senderId: message.replyTo.senderId,
      sender: replySenderPayload
    } : null;

    const mentions = await mentionService.processMentions(
      message.id,
      message.content || '',
      chatId,
      senderId,
      { 
        senderName: senderProfile?.name, 
        chatName: chatMetadata?.name || undefined 
      }
    );

    let mentionedUserIds = mentions
      .filter(m => m.targetType === 'USER' && m.targetId)
      .map(m => m.targetId) as string[];

    if (workspaceId && mentionedUserIds.length > 0) {
      try {
        const activeMentions = await prisma.workspaceMember.findMany({
          where: {
            workspaceId,
            userId: { in: mentionedUserIds },
            leftAt: null,
          },
          select: { userId: true },
        });
        const activeMentionIds = new Set(activeMentions.map(m => m.userId));
        mentionedUserIds = mentionedUserIds.filter(id => activeMentionIds.has(id));
      } catch (e) {
        logger.warn({ workspaceId }, 'Failed to filter mentioned users by workspace membership');
      }
    }

    const aiMentioned = mentions.some(m => m.targetType === 'AI');
    if (aiMentioned) {
      await publishEvent('ai.request', {
        messageId: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        content: message.content?.replace(/@AI/gi, '').trim(),
      });
    }

    await publishEvent(EventSubjects.MESSAGE_CREATED, {
      id: message.id,
      chatId: message.chatId,
      workspaceId,
      participantIds,
      mentionedUserIds, // Deduplication helper
      senderId: message.senderId,
      sender: senderPayload,
      content: message.content,
      type: message.type,
      time: message.time.toISOString(),
      replyTo: replyToPayload,
      file: fileName ? { name: fileName, size: fileSize, type: fileType } : null,
      reactions: [],
      pin: false,
    });

    logger.info({ messageId: message.id, chatId }, 'Message sent');

    return { ...message, sender: senderPayload, replyTo: replyToPayload };
  }

  async deleteMessageForMe(messageId: string, userId: string) {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new Error('Không tìm thấy tin nhắn!');

    const hasAccess = await hasChatAccess(message.chatId, userId);
    if (!hasAccess) {
      throw new Error('Bạn không còn là thành viên của nhóm này nên không thể xem nội dung');
    }

    let deletedBy: string[] = [];
    try { deletedBy = message.deletedBy ? JSON.parse(message.deletedBy) : []; } catch { deletedBy = []; }
    if (!deletedBy.includes(userId)) deletedBy.push(userId);

    await prisma.message.update({
      where: { id: messageId },
      data: { deletedBy: JSON.stringify(deletedBy) },
    });
    logger.info({ messageId, userId }, 'Message deleted for user');
  }

  async recallMessage(messageId: string, userId: string) {
    const message = await prisma.message.findUnique({ 
      where: { id: messageId }
    });
    if (!message) throw new Error('Không tìm thấy tin nhắn!');

    const hasAccess = await hasChatAccess(message.chatId, userId);
    if (!hasAccess) {
      throw new Error('Bạn không còn là thành viên của nhóm này nên không thể xem nội dung');
    }

    const chat = await prisma.chat.findUnique({
      where: { id: message.chatId },
      select: { 
        workspaceId: true,
        participants: { select: { accountId: true } },
        pinnedMessages: true
      }
    });
    const workspaceId = chat?.workspaceId || null;
    const participantIds = chat?.participants.map((p:any) => p.accountId) || [];

    if (message.senderId !== userId) throw new Error('Chỉ người gửi mới có thể thu hồi!');

    const timeDiff = Date.now() - new Date(message.time).getTime();
    if (timeDiff > 24 * 60 * 60 * 1000) throw new Error('Chỉ có thể thu hồi tin nhắn trong 24 giờ!');

    await prisma.message.update({ 
      where: { id: messageId }, 
      data: { destroy: true, content: 'Tin nhắn đã bị thu hồi', pin: false } 
    });

    // Remove from Chat.pinnedMessages if it was pinned
    if (message.pin) {
      const chatData = await prisma.chat.findUnique({ where: { id: message.chatId }, select: { pinnedMessages: true } });
      let pinnedList: any[] = [];
      try { pinnedList = Array.isArray(chatData?.pinnedMessages) ? (chatData.pinnedMessages as any[]) : []; } catch { pinnedList = []; }
      
      const newList = pinnedList.filter((m: any) => m.id !== messageId);
      await prisma.chat.update({
        where: { id: message.chatId },
        data: { pinnedMessages: newList }
      });
    }
    await publishEvent(EventSubjects.MESSAGE_DELETED, { 
       id: messageId, 
       chatId: message.chatId, 
       workspaceId: workspaceId,
       participantIds: participantIds,
       recalledBy: userId,
       content: 'Tin nhắn đã bị thu hồi'
    });
    logger.info({ messageId }, 'Message recalled');
  }

  async reactMessage(messageId: string, userId: string, emoji: string) {
    const message = await prisma.message.findUnique({ 
      where: { id: messageId }
    });
    if (!message) throw new Error('Không tìm thấy tin nhắn!');

    const hasAccess = await hasChatAccess(message.chatId, userId);
    if (!hasAccess) {
      throw new Error('Bạn không còn là thành viên của nhóm này nên không thể xem nội dung');
    }

    const chat = await prisma.chat.findUnique({
      where: { id: message.chatId },
      select: { 
        workspaceId: true,
        participants: { select: { accountId: true } },
        pinnedMessages: true
      }
    });
    const workspaceId = chat?.workspaceId || null;
    const participantIds = chat?.participants.map(p => p.accountId) || [];

    const existingReaction = await prisma.reaction.findFirst({ 
      where: { messageId, userId, reaction: emoji } 
    });
    let action: 'added' | 'changed' | 'removed';
    let currentCount = 1;

    if (existingReaction) {
      currentCount = (existingReaction.count || 1) + 1;
      await prisma.reaction.update({ 
        where: { id: existingReaction.id }, 
        data: { count: currentCount } 
      });
      action = 'added'; // Still 'added' as in incremented
    } else {
      await prisma.reaction.create({ 
        data: { id: uuidv4(), messageId, userId, reaction: emoji, count: 1 } 
      });
      action = 'added';
      currentCount = 1;
    }

    // Fetch userName for the event
    const user = await userorgClient.getUser(userId);
    const userName = user?.name || 'User';

    // Calculate total count for this emoji across all users
    const allReactionsForEmoji = await prisma.reaction.findMany({
      where: { messageId, reaction: emoji }
    });
    const totalCount = allReactionsForEmoji.reduce((sum, r) => sum + (r.count || 1), 0);

    await publishEvent(EventSubjects.MESSAGE_REACTION, { 
      messageId, 
      chatId: message.chatId, 
      workspaceId: workspaceId, 
      participantIds: participantIds,
      userId, 
      userName,
      emoji, 
      action,
      count: totalCount // Send the NEW TOTAL count
    });
    return { action, emoji, count: totalCount };
  }

  async togglePinMessage(messageId: string, userId: string) {
    const message = await prisma.message.findUnique({ 
      where: { id: messageId }
    });
    if (!message) throw new Error('Không tìm thấy tin nhắn!');

    const hasAccess = await hasChatAccess(message.chatId, userId);
    if (!hasAccess) {
      throw new Error('Bạn không còn là thành viên của nhóm này nên không thể xem nội dung');
    }

    const chat = await prisma.chat.findUnique({
      where: { id: message.chatId },
      select: { 
        workspaceId: true,
        participants: { select: { accountId: true } },
        pinnedMessages: true
      }
    });
    const workspaceId = chat?.workspaceId || null;
    const participantIds = chat?.participants.map(p => p.accountId) || [];

    const newPinState = !message.pin;
    const updated = await prisma.message.update({ where: { id: messageId }, data: { pin: newPinState } });
    
    // Get userName for pinned event
    let userName = 'Người dùng';
    try {
      const accountMap = await userorgClient.getUsers([userId]);
      userName = accountMap.get(userId)?.name || 'Người dùng';
    } catch (err) {
      logger.error({ err }, 'Failed to fetch user name for pin event');
    }

    // Publish NATS event for real-time update

    await publishEvent('message.pinned', {
      chatId: updated.chatId,
      workspaceId: workspaceId,
      participantIds: participantIds,
      messageId: updated.id,
      pin: newPinState,
      userId,
      userName
    });

    // Update Chat.pinnedMessages JSONB list
    let pinnedList: any[] = [];
    try { 
      pinnedList = Array.isArray(chat?.pinnedMessages) ? (chat.pinnedMessages as any[]) : []; 
    } catch { 
      pinnedList = []; 
    }

    if (newPinState) {
      // Get sender info for the pinned message
      const senderAccMap = await userorgClient.getUsers([message.senderId]);
      const senderAcc = senderAccMap.get(message.senderId);

      const pinnedMsgMetadata = {
        id: message.id,
        content: message.content || (message.type === 'image' ? '[Hình ảnh]' : message.type === 'file' ? `[Tệp tin: ${message.fileName}]` : '[Tin nhắn]'),
        senderName: senderAcc?.name || 'Người dùng',
        senderAvatar: senderAcc?.avatar || null,
        pinnedBy: userId,
        pinnedByName: userName,
        pinnedAt: new Date().toISOString(),
        type: message.type
      };
      
      // Remove if already exists (prevent duplicates) then unshift
      pinnedList = pinnedList.filter((m: any) => m.id !== messageId);
      pinnedList.unshift(pinnedMsgMetadata);
      if (pinnedList.length > 50) pinnedList.pop();
    } else {
      pinnedList = pinnedList.filter((m: any) => m.id !== messageId);
    }

    await prisma.chat.update({
      where: { id: message.chatId },
      data: { pinnedMessages: pinnedList }
    });

    logger.info({ messageId, pin: newPinState }, 'Message pin toggled');
    return { pin: newPinState };
  }

  async forwardMessage(
    originalMessageId: string,
    targetChatId: string,
    senderId: string
  ) {
    // 1. Dual Auth Check - Check Source and Target chat access
    const originalMessage = await prisma.message.findUnique({
      where: { id: originalMessageId }
    });
    if (!originalMessage) {
      throw new Error('Tin nhắn gốc không tồn tại!');
    }

    // Check Source: User must be participant of original message's chat room
    const sourceParticipant = await prisma.chatParticipant.findUnique({
      where: {
        chatId_accountId: {
          chatId: originalMessage.chatId,
          accountId: senderId
        }
      }
    });
    if (!sourceParticipant) {
      throw new Error('Bạn không có quyền truy cập tin nhắn gốc!');
    }

    // Check Target: User must be participant of target chat room
    const targetChatMetadata = await prisma.chat.findUnique({
      where: { id: targetChatId },
      select: {
        id: true,
        isGroup: true,
        name: true,
        workspaceId: true,
        isReadOnly: true,
        participants: { select: { accountId: true, role: true } }
      }
    });
    if (!targetChatMetadata) {
      throw new Error('Phòng chat đích không tồn tại!');
    }

    const targetParticipant = targetChatMetadata.participants.find(p => p.accountId === senderId);
    if (!targetParticipant) {
      throw new Error('Bạn không có quyền gửi tin nhắn tới phòng chat này!');
    }

    // Check Read-only permission of target chat
    if (targetChatMetadata.isReadOnly) {
      const privilegedRoles = ['CHANNEL_OWNER', 'CHANNEL_MODERATOR', 'WORKSPACE_ADMIN', 'WORKSPACE_OWNER'];
      if (!privilegedRoles.includes(targetParticipant.role)) {
        let isWorkspacePrivileged = false;
        if (targetChatMetadata.workspaceId) {
          try {
            const workspaceMember = await prisma.workspaceMember.findUnique({
              where: { workspaceId_userId: { workspaceId: targetChatMetadata.workspaceId, userId: senderId } },
              select: { role: true, leftAt: true }
            });
            if (workspaceMember && workspaceMember.leftAt === null &&
                (workspaceMember.role === 'WORKSPACE_ADMIN' || workspaceMember.role === 'WORKSPACE_OWNER')) {
              isWorkspacePrivileged = true;
            }
          } catch (e) {
            logger.warn({ senderId, workspaceId: targetChatMetadata.workspaceId }, 'Failed to check workspace member role');
          }
        }
        if (!isWorkspacePrivileged) {
          throw new Error('Kênh này đang ở chế độ chỉ đọc. Chỉ quản trị viên mới có thể gửi tin nhắn.');
        }
      }
    }

    // For 1-1 target chats, check block status
    if (!targetChatMetadata.isGroup) {
      const partner = targetChatMetadata.participants.find(p => p.accountId !== senderId);
      if (partner) {
        const blockInfo = await userorgClient.checkBlockedStatus(senderId, partner.accountId);
        if (blockInfo.isBlocked) {
          throw new Error('Bạn không thể gửi tin nhắn cho người này vì đã bị chặn hoặc bạn đã chặn người này!');
        }
      }
    }

    // 2. Clone the original message parameters to target chat
    const clonedMessage = await prisma.message.create({
      data: {
        id: uuidv4(),
        chatId: targetChatId,
        senderId,
        content: originalMessage.content,
        type: originalMessage.type,
        fileName: originalMessage.fileName,
        fileSize: originalMessage.fileSize,
        fileType: originalMessage.fileType,
        isForwarded: true,
        forwardFromId: originalMessageId,
      }
    });

    // Unhide chat for all participants in target chat so it reappears
    await prisma.chatParticipant.updateMany({
      where: { chatId: targetChatId, hidden: true },
      data: { hidden: false },
    }).catch(() => {});

    // 3. Hydrate sender profile
    let senderProfile = null;
    try {
      const accountMap = await userorgClient.getUsers([senderId]);
      senderProfile = accountMap.get(senderId);
    } catch (err) {
      logger.error({ err }, 'Failed to fetch user profiles for forwarded message');
    }

    // Determine sender role for forwarded message
    let senderRole = 'EMPLOYEE';
    if (senderProfile?.role === 'SUPER_ADMIN') {
      senderRole = 'SUPER_ADMIN';
    } else if (senderProfile?.role === 'ADMIN') {
      senderRole = 'SYSTEM_ADMIN';
    } else if (senderProfile?.role === 'WORKSPACE_MANAGER') {
      senderRole = 'WORKSPACE_MANAGER';
    }

    const workspaceId = targetChatMetadata.workspaceId;
    if (workspaceId && senderRole === 'EMPLOYEE') {
      try {
        const workspace = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { departmentId: true }
        });
        const departmentId = workspace?.departmentId || null;

        const wMember = await prisma.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: senderId } },
          select: { role: true, leftAt: true }
        });
        if (wMember && wMember.leftAt === null && ['WORKSPACE_ADMIN', 'WORKSPACE_OWNER'].includes(wMember.role)) {
          senderRole = 'WORKSPACE_ADMIN';
        } else if (wMember && wMember.leftAt === null && departmentId) {
          const deptHeads = await prisma.$queryRaw<any[]>`
            SELECT "role" 
            FROM rbac.department_member 
            WHERE "departmentId" = ${departmentId} 
              AND "userId" = ${senderId}
              AND "role" IN ('HEAD', 'MANAGER')
          `;
          if (Array.isArray(deptHeads) && deptHeads.length > 0) {
            senderRole = 'DEPARTMENT_HEAD';
          }
        }
      } catch (e) {
        logger.warn({ e, workspaceId }, 'Failed to resolve sender role for forwardMessage');
      }
    }

    const senderPayload = senderProfile ? {
      id: senderProfile.id,
      name: senderProfile.name,
      avatar: senderProfile.avatar,
      role: senderRole,
    } : undefined;

    // Filter participantIds of target chat for real-time notification
    let targetParticipantIds = targetChatMetadata.participants.map(p => p.accountId);
    if (targetChatMetadata.workspaceId) {
      try {
        const activeMembers = await prisma.workspaceMember.findMany({
          where: {
            workspaceId: targetChatMetadata.workspaceId,
            userId: { in: targetParticipantIds },
            leftAt: null,
          },
          select: { userId: true },
        });
        const activeMemberIds = new Set(activeMembers.map(m => m.userId));
        targetParticipantIds = targetParticipantIds.filter(id => activeMemberIds.has(id));
      } catch (e) {
        logger.warn({ workspaceId: targetChatMetadata.workspaceId }, 'Failed to filter message participants by workspace membership');
      }
    }

    // 4. Real-time Pub/Sub using NATS JetStream event MESSAGE_CREATED
    await publishEvent(EventSubjects.MESSAGE_CREATED, {
      id: clonedMessage.id,
      chatId: targetChatId,
      workspaceId: targetChatMetadata.workspaceId,
      participantIds: targetParticipantIds,
      mentionedUserIds: [], // Forward does not trigger mentions
      senderId,
      sender: senderPayload,
      content: clonedMessage.content,
      type: clonedMessage.type,
      time: clonedMessage.time.toISOString(),
      replyTo: null, // Forwarded messages are not replies
      file: clonedMessage.fileName ? { name: clonedMessage.fileName, size: clonedMessage.fileSize, type: clonedMessage.fileType } : null,
      reactions: [],
      pin: false,
      isForwarded: true,
      forwardFromId: originalMessageId,
    });

    logger.info({ messageId: clonedMessage.id, originalMessageId, targetChatId }, 'Message forwarded');

    return { ...clonedMessage, sender: senderPayload, replyTo: null };
  }

  async getPinnedMessages(chatId: string, userId: string) {
    const participant = await prisma.chatParticipant.findUnique({
      where: { chatId_accountId: { chatId, accountId: userId } },
      select: { clearedAt: true }
    });
    const clearedAt = participant?.clearedAt;

    const whereCondition: any = {
      chatId,
      pin: true,
      destroy: false
    };

    if (clearedAt) {
      whereCondition.time = { gt: clearedAt };
    }

    const messages = await prisma.message.findMany({
      where: whereCondition,
      orderBy: { time: 'desc' },
    });
    return this.populateSenderInfo(messages, chatId);
  }

  async searchMessages(chatId: string, query: string, userId: string) {
    if (!query || query.trim().length < 1) throw new Error('Từ khóa phải có ít nhất 1 ký tự!');

    const participant = await prisma.chatParticipant.findUnique({
      where: { chatId_accountId: { chatId, accountId: userId } },
      select: { clearedAt: true }
    });
    const clearedAt = participant?.clearedAt;

    const whereCondition: any = {
      chatId,
      destroy: false,
      content: { contains: query, mode: 'insensitive' },
      type: 'text'
    };

    if (clearedAt) {
      whereCondition.time = { gt: clearedAt };
    }

    const messages = await prisma.message.findMany({
      where: whereCondition,
      orderBy: { time: 'desc' },
      take: 50,
    });
    return this.populateSenderInfo(messages, chatId);
  }

  async getMediaMessages(chatId: string, type: string | undefined, userId: string) {
    const participant = await prisma.chatParticipant.findUnique({
      where: { chatId_accountId: { chatId, accountId: userId } },
      select: { clearedAt: true }
    });
    const clearedAt = participant?.clearedAt;

    let typeFilter: string[] = [];
    if (type === 'image') typeFilter = ['image'];
    else if (type === 'video') typeFilter = ['video'];
    else if (type === 'file') typeFilter = ['file', 'audio'];
    else typeFilter = ['image', 'video', 'file', 'audio'];

    const whereCondition: any = {
      chatId,
      destroy: false,
      type: { in: typeFilter }
    };

    if (clearedAt) {
      whereCondition.time = { gt: clearedAt };
    }

    const messages = await prisma.message.findMany({
      where: whereCondition,
      orderBy: { time: 'desc' },
      take: 100,
    });
    return this.populateSenderInfo(messages, chatId);
  }

  private groupReactions(reactions: any[]) {
    return reactions.reduce((acc: any[], r) => {
      const existing = acc.find((a) => a.emoji === r.reaction);
      if (existing) { 
        existing.count += (r.count || 1); 
        if (!existing.users) existing.users = [];
        const userExists = existing.users.some((u: any) => u.id === r.userId);
        if (!userExists) {
          existing.users.push({ id: r.userId }); 
        }
      }
      else { 
        acc.push({ emoji: r.reaction, count: (r.count || 1), users: [{ id: r.userId }] }); 
      }
      return acc;
    }, []);
  }

  private async populateSenderInfo(messages: any[], chatId?: string) {
    if (!messages || messages.length === 0) return messages;
    
    // Gom tất cả ID người gửi duy nhất (của tin nhắn chính và replyTo)
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.senderId) ids.add(m.senderId);
      if (m.replyTo?.senderId) ids.add(m.replyTo.senderId);
    }
    const uniqueAccountIds = Array.from(ids);
    
    // Sử dụng userorgClient (đã tích hợp Redis Cache & Batching)
    const accountMap = await userorgClient.getUsers(uniqueAccountIds);

    // Xác định Workspace ID và Department ID của Chat
    let workspaceId: string | null = null;
    let departmentId: string | null = null;

    if (chatId) {
      try {
        const chat = await prisma.chat.findUnique({
          where: { id: chatId },
          select: {
            workspaceId: true,
            workspace: {
              select: {
                departmentId: true
              }
            }
          }
        });
        workspaceId = chat?.workspaceId || null;
        departmentId = chat?.workspace?.departmentId || null;
      } catch (e) {
        logger.warn({ e, chatId }, 'Failed to fetch chat workspace and department info in populateSenderInfo');
      }
    }

    // 1. Fetch Workspace Members
    const adminUserIds = new Set<string>();
    if (workspaceId && uniqueAccountIds.length > 0) {
      try {
        const admins = await prisma.workspaceMember.findMany({
          where: {
            workspaceId,
            userId: { in: uniqueAccountIds },
            role: { in: ['WORKSPACE_ADMIN', 'WORKSPACE_OWNER'] },
            leftAt: null
          },
          select: { userId: true }
        });
        admins.forEach(a => adminUserIds.add(a.userId));
      } catch (e) {
        logger.warn({ e, workspaceId }, 'Failed to fetch workspace admins for sender role population');
      }
    }

    // 2. Fetch Department Head/Manager Members using raw query on rbac.department_member
    const deptHeadUserIds = new Set<string>();
    if (departmentId && uniqueAccountIds.length > 0) {
      try {
        const deptHeads = await prisma.$queryRaw<any[]>`
          SELECT "userId" 
          FROM rbac.department_member 
          WHERE "departmentId" = ${departmentId} 
            AND "userId" = ANY(${uniqueAccountIds})
            AND "role" IN ('HEAD', 'MANAGER')
        `;
        if (Array.isArray(deptHeads)) {
          deptHeads.forEach(d => deptHeadUserIds.add(d.userId));
        }
      } catch (e) {
        logger.warn({ e, departmentId }, 'Failed to query department managers for sender role population');
      }
    }

    return messages.map((msg) => {
      const senderAcc = accountMap.get(msg.senderId);
      
      let senderRole = 'EMPLOYEE';
      if (senderAcc?.role === 'SUPER_ADMIN') {
        senderRole = 'SUPER_ADMIN';
      } else if (senderAcc?.role === 'ADMIN') {
        senderRole = 'SYSTEM_ADMIN';
      } else if (senderAcc?.role === 'WORKSPACE_MANAGER') {
        senderRole = 'WORKSPACE_MANAGER';
      } else if (adminUserIds.has(msg.senderId)) {
        senderRole = 'WORKSPACE_ADMIN';
      } else if (deptHeadUserIds.has(msg.senderId)) {
        senderRole = 'DEPARTMENT_HEAD';
      }

      let replyTo = null;
      if (msg.replyTo) {
        const replySenderAcc = accountMap.get(msg.replyTo.senderId);
        
        let replyRole = 'EMPLOYEE';
        if (replySenderAcc?.role === 'SUPER_ADMIN') {
          replyRole = 'SUPER_ADMIN';
        } else if (replySenderAcc?.role === 'ADMIN') {
          replyRole = 'SYSTEM_ADMIN';
        } else if (replySenderAcc?.role === 'WORKSPACE_MANAGER') {
          replyRole = 'WORKSPACE_MANAGER';
        } else if (adminUserIds.has(msg.replyTo.senderId)) {
          replyRole = 'WORKSPACE_ADMIN';
        } else if (deptHeadUserIds.has(msg.replyTo.senderId)) {
          replyRole = 'DEPARTMENT_HEAD';
        }

        replyTo = {
          ...msg.replyTo,
          sender: replySenderAcc ? { 
            id: replySenderAcc.id, 
            name: replySenderAcc.name, 
            avatar: replySenderAcc.avatar,
            role: replyRole
          } : undefined,
        };
      }
      return {
        ...msg,
        sender: senderAcc ? { 
          id: senderAcc.id, 
          name: senderAcc.name, 
          avatar: senderAcc.avatar,
          role: senderRole
        } : undefined,
        replyTo,
      };
    });
  }

  async getChatSummary(userId: string, chatIds: string[]) {
    // 1. Lấy dữ liệu cơ bản từ DB cho tất cả chat
    const summariesRaw = await Promise.all(
      chatIds.map(async (chatId) => {
        const participant = await prisma.chatParticipant.findUnique({
          where: { chatId_accountId: { chatId, accountId: userId } },
          select: { clearedAt: true }
        });
        const clearedAt = participant?.clearedAt || null;

        const lastMessageWhere: any = { chatId };
        if (clearedAt) {
          lastMessageWhere.time = { gt: clearedAt };
        }

        const lastMessage = await prisma.message.findFirst({
          where: lastMessageWhere,
          orderBy: { time: 'desc' },
        });

        const readReceipt = await prisma.readReceipt.findUnique({
          where: { chatId_userId: { chatId, userId } },
        });

        let unreadCount = 0;
        if (readReceipt) {
          const lastReadMsg = await prisma.message.findUnique({ where: { id: readReceipt.messageId } });
          if (lastReadMsg) {
            const unreadWhere: any = {
              chatId,
              destroy: false,
              senderId: { not: userId }
            };
            if (clearedAt && clearedAt > lastReadMsg.time) {
              unreadWhere.time = { gt: clearedAt };
            } else {
              unreadWhere.time = { gt: lastReadMsg.time };
            }
            unreadCount = await prisma.message.count({
              where: unreadWhere,
            });
          }
        } else {
          const unreadWhere: any = {
            chatId,
            destroy: false,
            senderId: { not: userId }
          };
          if (clearedAt) {
            unreadWhere.time = { gt: clearedAt };
          }
          unreadCount = await prisma.message.count({
            where: unreadWhere,
          });
        }

        const chat = await prisma.chat.findUnique({
          where: { id: chatId },
          select: { workspaceId: true }
        });

        return { chatId, workspaceId: chat?.workspaceId || null, lastMessage, unreadCount };
      })
    );

    // 2. TỐI ƯU: Gom tất cả senderId của các lastMessage để hydrate 1 lần duy nhất
    const allSenderIds = summariesRaw
      .filter(s => s.lastMessage)
      .map(s => s.lastMessage!.senderId);
    
    const accountMap = await userorgClient.getUsers(allSenderIds);

    // 3. Format lại kết quả cuối cùng
    return summariesRaw.map((s) => {
      const lastMessage = s.lastMessage;
      let sender = null;
      let displayContent = null;

      if (lastMessage) {
        const acc = accountMap.get(lastMessage.senderId);
        sender = acc ? { id: acc.id, name: acc.name, avatar: acc.avatar } : { id: lastMessage.senderId, name: 'Người dùng' };

        displayContent = lastMessage.content;
        if (!displayContent) {
          switch (lastMessage.type) {
            case 'image': displayContent = '[Hình ảnh]'; break;
            case 'video': displayContent = '[Video]'; break;
            case 'audio': displayContent = '[Âm thanh]'; break;
            case 'file': displayContent = `[Tệp tin: ${lastMessage.fileName || 'Không tên'}]`; break;
            case 'call_participant_joined': displayContent = '[Thành viên tham gia cuộc gọi]'; break;
            case 'call_participant_left': displayContent = '[Thành viên rời cuộc gọi]'; break;
            case 'call_started': displayContent = '[Cuộc gọi mới]'; break;
            case 'call_ended': displayContent = '[Cuộc gọi đã kết thúc]'; break;
            case 'call_missed': displayContent = '[Cuộc gọi nhỡ]'; break;
            case 'call_declined': displayContent = '[Cuộc gọi bị từ chối]'; break;
            case 'call_cancelled': displayContent = '[Cuộc gọi đã hủy]'; break;
            case 'system': displayContent = '[Thông báo hệ thống]'; break;
            default: displayContent = '[Tin nhắn mới]';
          }
        }
      }

      return {
        chatId: s.chatId,
        workspaceId: s.workspaceId,
        lastMessage: lastMessage ? {
          id: lastMessage.id,
          content: displayContent,
          type: lastMessage.type,
          time: lastMessage.time,
          sender
        } : null,
        unreadCount: s.unreadCount,
      };
    });
  }
}

export const messageService = new MessageService();
