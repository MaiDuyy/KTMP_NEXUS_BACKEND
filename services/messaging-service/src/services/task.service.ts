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

    if (start && deadline && start >= deadline) {
      throw new Error('Thời gian bắt đầu phải trước thời gian hoàn thành (deadline)!');
    }

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

    // 1. Lấy tất cả thành viên trong nhóm để gửi thông báo real-time
    const participants = await prisma.chatParticipant.findMany({
      where: { chatId },
      select: { accountId: true }
    });
    const memberIds = participants.map(p => p.accountId);

    // 2. Thông báo ngay lập tức về việc tạo task
    await publishEvent(EventSubjects.TASK_CREATED, {
      chatId,
      task,
      memberIds
    });

    // 2. Lập lịch thông báo Cận Date (Delayed Message: trước 1h30p)
    if (task.deadlineAt) {
      const notifyTime = new Date(task.deadlineAt.getTime() - (1 * 60 + 30) * 60 * 1000);
      const now = new Date();

      if (notifyTime > now) {
        // Gửi event để hệ thống Notification xử lý (có kèm delay_until)
        // Lưu ý: Tùy vào cấu hình NATS/Worker mà delay sẽ được xử lý tại đây hoặc Notification Service
        await publishEvent(EventSubjects.TASK_DEADLINE_APPROACHING, {
          taskId: task.id,
          chatId,
          title: task.title,
          assigneeIds,
          assignedTo: assigneeIds,
          deadline: task.deadlineAt.toISOString(),
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
        content: task.id,
        type: 'task'
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

    const isLeader = participant?.role === 'CHANNEL_OWNER' || participant?.role === 'CHANNEL_MODERATOR';

    if (!isAssignee && !isLeader) {
      throw new Error('Bạn không có quyền cập nhật trạng thái này!');
    }

    // Check status rules: Member cannot cancel tasks
    if (status === 'CANCELLED' && !isLeader) {
      throw new Error('Chỉ chủ sở hữu kênh hoặc quản trị kênh mới có quyền hủy kế hoạch!');
    }

    const updatedTask = await prisma.task.update({
      where: { id: taskId },
      data: { status }
    });

    // Lấy tất cả thành viên trong nhóm để gửi thông báo real-time
    const participants = await prisma.chatParticipant.findMany({
      where: { chatId: task.chatId },
      select: { accountId: true }
    });
    const memberIds = participants.map(p => p.accountId);

    await publishEvent(EventSubjects.TASK_UPDATED, {
      taskId,
      chatId: task.chatId,
      status,
      updatedBy: userId,
      memberIds
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

    // 2. Lấy tất cả thành viên trong nhóm để gửi thông báo real-time
    const participants = await prisma.chatParticipant.findMany({
      where: { chatId },
      select: { accountId: true }
    });
    const memberIds = participants.map(p => p.accountId);

    // 3. Thực hiện xóa (Prisma Cascade sẽ tự xóa assignees nếu đã config)
    const result = await prisma.task.delete({
      where: { id: taskId }
    });

    // 4. Phát sự kiện xóa kế hoạch qua NATS
    await publishEvent(EventSubjects.TASK_DELETED, {
      taskId,
      chatId,
      deletedBy: userId,
      memberIds
    });

    return result;
  }
}

export const taskService = new TaskService();
