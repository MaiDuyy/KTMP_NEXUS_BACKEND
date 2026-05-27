import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { userorgClient } from '../lib/userorgClient.js';

export class PollService {
  async createPoll(
    chatId: string,
    creatorId: string,
    input: {
      title: string;
      options: string[];
      endsAt?: string;
    }
  ) {
    const { title, options, endsAt } = input;

    if (!title || title.trim().length === 0) {
      throw new Error('Tiêu đề cuộc bình chọn không được để trống!');
    }

    if (!options || !Array.isArray(options) || options.length < 2) {
      throw new Error('Cuộc bình chọn phải có ít nhất 2 lựa chọn!');
    }

    if (options.length > 10) {
      throw new Error('Cuộc bình chọn tối đa chỉ được có 10 lựa chọn!');
    }

    const cleanOptions = options.map((opt) => opt.trim()).filter((opt) => opt.length > 0);
    if (cleanOptions.length < 2) {
      throw new Error('Các phương án bình chọn không hợp lệ!');
    }

    // 1. Kiểm tra chat tồn tại và lấy metadata
    const chatMetadata = await prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        workspaceId: true,
        participants: { select: { accountId: true } },
      },
    });

    if (!chatMetadata) {
      throw new Error('Không tìm thấy cuộc trò chuyện!');
    }

    const workspaceId = chatMetadata.workspaceId;
    let participantIds = chatMetadata.participants.map((p) => p.accountId);

    // Lọc thành viên active của workspace nếu chat nằm trong workspace
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
        const activeMemberIds = new Set(activeMembers.map((m) => m.userId));
        participantIds = participantIds.filter((id) => activeMemberIds.has(id));
      } catch (e: any) {
        logger.warn({ workspaceId, err: e.message }, 'Failed to filter participants by workspace membership in createPoll');
      }
    }

    // 2. Tạo bản ghi Poll và tin nhắn hiển thị
    const pollId = uuidv4();
    const messageId = uuidv4();
    const endsAtDate = endsAt ? new Date(endsAt) : null;

    const result = await prisma.$transaction(async (tx) => {
      // a. Tạo Poll
      const poll = await tx.poll.create({
        data: {
          id: pollId,
          chatId,
          creatorId,
          title: title.trim(),
          endsAt: endsAtDate,
          options: {
            create: cleanOptions.map((text) => ({
              id: uuidv4(),
              text,
            })),
          },
        },
        include: {
          options: true,
        },
      });

      // b. Tạo tin nhắn loại 'poll' với nội dung là pollId
      const message = await tx.message.create({
        data: {
          id: messageId,
          chatId,
          senderId: creatorId,
          content: pollId,
          type: 'poll',
        },
      });

      return { poll, message };
    });

    // 3. Hydrate thông tin người gửi
    let senderProfile = null;
    try {
      const accountMap = await userorgClient.getUsers([creatorId]);
      senderProfile = accountMap.get(creatorId);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to fetch user profile in createPoll');
    }

    const senderPayload = senderProfile
      ? {
          id: senderProfile.id,
          name: senderProfile.name,
          avatar: senderProfile.avatar,
        }
      : undefined;

    // 4. Phát sự kiện tạo tin nhắn mới để hiển thị bong bóng chat
    await publishEvent(EventSubjects.MESSAGE_CREATED, {
      id: result.message.id,
      chatId: result.message.chatId,
      workspaceId,
      participantIds,
      mentionedUserIds: [],
      senderId: result.message.senderId,
      sender: senderPayload,
      content: result.message.content,
      type: result.message.type,
      time: result.message.time.toISOString(),
      replyTo: null,
      file: null,
      reactions: [],
      pin: false,
    });

    logger.info({ pollId, chatId }, 'Poll and poll message created successfully');

    return {
      ...result.poll,
      options: result.poll.options.map((opt) => ({
        ...opt,
        votes: [],
        _count: { votes: 0 },
      })),
      votedOptionId: null,
    };
  }

  async getPoll(pollId: string, userId: string) {
    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      include: {
        options: {
          include: {
            votes: {
              select: {
                voterId: true,
              },
            },
          },
        },
      },
    });

    if (!poll) {
      throw new Error('Không tìm thấy cuộc khảo sát!');
    }

    let votedOptionId: string | null = null;
    const formattedOptions = poll.options.map((opt) => {
      const voters = opt.votes.map((v) => v.voterId);
      if (voters.includes(userId)) {
        votedOptionId = opt.id;
      }
      return {
        id: opt.id,
        pollId: opt.pollId,
        text: opt.text,
        createdAt: opt.createdAt,
        votes: voters,
        _count: { votes: voters.length },
      };
    });

    const isExpired = poll.endsAt ? new Date() > poll.endsAt : false;

    return {
      id: poll.id,
      chatId: poll.chatId,
      creatorId: poll.creatorId,
      title: poll.title,
      createdAt: poll.createdAt,
      updatedAt: poll.updatedAt,
      endsAt: poll.endsAt,
      isExpired,
      options: formattedOptions,
      votedOptionId,
    };
  }

  async vote(pollId: string, userId: string, optionId: string) {
    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      include: {
        options: true,
      },
    });

    if (!poll) {
      throw new Error('Không tìm thấy cuộc khảo sát!');
    }

    if (poll.endsAt && new Date() > poll.endsAt) {
      throw new Error('Cuộc khảo sát này đã kết thúc!');
    }

    const optionExists = poll.options.some((opt) => opt.id === optionId);
    if (!optionExists) {
      throw new Error('Phương án bình chọn không hợp lệ!');
    }

    // Thực hiện transaction vote: Một user chỉ được chọn một phương án duy nhất trong Poll này
    await prisma.$transaction(async (tx) => {
      // 1. Xóa mọi vote cũ của user trong cuộc bình chọn này
      await tx.pollVote.deleteMany({
        where: {
          voterId: userId,
          option: {
            pollId,
          },
        },
      });

      // 2. Thêm vote mới
      await tx.pollVote.create({
        data: {
          id: uuidv4(),
          pollOptionId: optionId,
          voterId: userId,
        },
      });
    });

    // Lấy trạng thái cập nhật mới nhất của Poll
    const updatedPoll = await this.getPoll(pollId, userId);

    // Phát sự kiện cập nhật kết quả khảo sát qua NATS
    await publishEvent(EventSubjects.POLL_UPDATED, {
      pollId,
      chatId: poll.chatId,
      options: updatedPoll.options,
      totalVotes: updatedPoll.options.reduce((sum, opt) => sum + opt.votes.length, 0),
    });

    logger.info({ pollId, userId, optionId }, 'User voted successfully');

    return updatedPoll;
  }
}

export const pollService = new PollService();
