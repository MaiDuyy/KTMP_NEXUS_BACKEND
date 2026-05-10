import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { messageService } from './message.service.js';
import { userorgClient } from '../lib/userorgClient.js';

export class TaskService {
  /**
   * Tạo task mới
   */
  async createTask(
    chatId: string,
    creatorId: string,
    data: { title: string; description?: string; deadlineAt?: string, startAt?: string },
    assigneeIds: string[]
  ) {
    // RBAC: Check if user is in group and has permission
    const participant = await prisma.chatParticipant.findFirst({
      where: { chatId, accountId: creatorId }
    });

    if (!participant || (participant.role !== 'CHANNEL_OWNER' && participant.role !== 'CHANNEL_MODERATOR')) {
      throw new Error('Chỉ chủ sở hữu kênh hoặc quản trị kênh mới có quyền tạo kế hoạch!');
    }

    const deadline = data.deadlineAt ? new Date(data.deadlineAt) : null;
    const start = data.startAt ? new Date(data.startAt) : null;

    const task = await prisma.task.create({
      data: {
        chatId,
        creatorId,
        title: data.title,
        description: data.description,
        deadlineAt: deadline,
        startAt: start,
        assignees: {
          create: assigneeIds.map(accId => ({ accountId: accId }))
        }
      },
      include: {
        assignees: true
      }
    });

    // 1. Thông báo ngay lập tức về việc tạo task
    await publishEvent(EventSubjects.TASK_CREATED, {
      taskId: task.id,
      chatId,
      creatorId,
      title: task.title,
      deadlineAt: task.deadlineAt,
      assigneeIds
    });

    // 2. Lập lịch thông báo Cận Date (Delayed Message)
    if (task.deadlineAt) {
      const notifyTime = new Date(task.deadlineAt.getTime() - 24 * 60 * 60 * 1000);
      const now = new Date();

      if (notifyTime > now) {
        // Gửi event để hệ thống Notification xử lý (có kèm delay_until)
        // Lưu ý: Tùy vào cấu hình NATS/Worker mà delay sẽ được xử lý tại đây hoặc Notification Service
        await publishEvent(EventSubjects.TASK_DEADLINE_APPROACHING, {
          taskId: task.id,
          chatId,
          title: task.title,
          assigneeIds,
          notifyAt: notifyTime.toISOString(),
          delayMs: notifyTime.getTime() - now.getTime()
        });
      }
    }

    logger.info({ taskId: task.id, chatId }, 'Task created');

    // System Message: Task created
    try {
      const accountMap = await userorgClient.getUsers([creatorId]);
      const userName = accountMap.get(creatorId)?.name || 'Người dùng';
      await messageService.sendMessage(chatId, creatorId, {
        content: `${userName} đã tạo kế hoạch: "${task.title}"`,
        type: 'system'
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to send system message for task creation');
    }

    return task;
  }

  /**
   * Cập nhật trạng thái task
   */
  async updateTaskStatus(taskId: string, userId: string, status: any) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { assignees: true }
    });

    if (!task) throw new Error('Không tìm thấy kế hoạch!');

    // Check if assignee or group admin
    const isAssignee = task.assignees.some(a => a.accountId === userId);
    const participant = await prisma.chatParticipant.findFirst({
      where: { chatId: task.chatId, accountId: userId }
    });

    if (!isAssignee && (!participant || participant.role === 'CHANNEL_MEMBER')) {
      throw new Error('Bạn không có quyền cập nhật trạng thái này!');
    }

    const updatedTask = await prisma.task.update({
      where: { id: taskId },
      data: { status }
    });

    await publishEvent(EventSubjects.TASK_UPDATED, {
      taskId,
      chatId: task.chatId,
      status,
      updatedBy: userId
    });

    // System Message: Task status updated
    try {
      const accountMap = await userorgClient.getUsers([userId]);
      const userName = accountMap.get(userId)?.name || 'Người dùng';
      const statusLabel = status === 'DONE' ? 'Hoàn thành' : status === 'CANCELLED' ? 'Đã hủy' : 'Đang thực hiện';
      
      await messageService.sendMessage(task.chatId, userId, {
        content: `${userName} đã cập nhật kế hoạch "${task.title}" sang "${statusLabel}"`,
        type: 'system'
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to send system message for task status update');
    }

    return updatedTask;
  }

  /**
   * Lấy danh sách task trong nhóm
   */
  async getTasks(chatId: string) {
    const tasks = await prisma.task.findMany({
      where: { chatId },
      include: {
        assignees: true,
      },
      orderBy: { deadlineAt: 'asc' }
    });

    // Populate user info for assignees
    const allAssigneeIds = [...new Set(tasks.flatMap(t => t.assignees.map(a => a.accountId)))];
    const accountMap = await userorgClient.getUsers(allAssigneeIds);

    return tasks.map(task => ({
      ...task,
      assignees: task.assignees.map(a => {
        const acc = accountMap.get(a.accountId);
        return {
          ...a,
          name: acc?.name || 'Người dùng',
          avatar: acc?.avatar || null
        };
      })
    }));
  }

  /**
   * Xóa task (Chỉ CHANNEL_OWNER/CHANNEL_MODERATOR)
   */
  async deleteTask(taskId: string, userId: string, chatId: string) {
    // 1. Kiểm tra quyền hạn trong chat
    const participant = await prisma.chatParticipant.findFirst({
      where: { chatId, accountId: userId }
    });

    if (!participant || (participant.role !== 'CHANNEL_OWNER' && participant.role !== 'CHANNEL_MODERATOR')) {
      throw new Error('Chỉ chủ sở hữu kênh hoặc quản trị kênh mới có quyền xóa kế hoạch!');
    }

    // 2. Thực hiện xóa (Prisma Cascade sẽ tự xóa assignees nếu đã config)
    return prisma.task.delete({
      where: { id: taskId }
    });
  }
}

export const taskService = new TaskService();
