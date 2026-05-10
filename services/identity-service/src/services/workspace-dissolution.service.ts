import { messagingGrpc } from '../lib/messagingClient.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export class WorkspaceDissolutionService {
  /**
   * Luồng 1: OWNER Giải Tán Workspace
   */
  async dissolveWorkspace(workspaceId: string, userId: string, workspaceNameConfirm: string) {
    // 1. Lấy thông tin Workspace từ Messaging service (Source of Truth)
    const workspace = await messagingGrpc.getWorkspaceMetadata(workspaceId);
    if (!workspace) throw new Error('Không tìm thấy Workspace!');

    // 2. Kiểm tra quyền và tên xác nhận (đã được thực hiện ở Messaging Service qua gRPC call, 
    // nhưng ta có thể check lại metadata ở đây nếu cần logic bổ sung)
    
    try {
      // 3. Thực hiện giải tán ở Messaging service (Soft Delete)
      // Messaging service sẽ cập nhật status workspace, status groups, status members và invites.
      await messagingGrpc.dissolveWorkspace(workspaceId, userId, workspaceNameConfirm);

      // 4. Lấy danh sách thành viên để xử lý archive chat 1-1
      const members = await messagingGrpc.getWorkspaceMembers(workspaceId);
      await this.processOneToOneArchiving(members);

      // 5. Phát sự kiện NATS cho Notification Service
      await publishEvent(EventSubjects.WORKSPACE_DISSOLVED, {
        workspaceId,
        name: workspace.name,
        dissolvedBy: userId,
        memberIds: members,
        timestamp: new Date().toISOString()
      });

      logger.info({ workspaceId, dissolvedBy: userId }, 'Workspace dissolution orchestrated successfully');
      return { success: true, message: 'Workspace đã được giải tán thành công.' };
    } catch (error) {
      logger.error({ error, workspaceId }, 'Error during workspace dissolution orchestration');
      throw error;
    }
  }

  /**
   * Xử lý lưu trữ chat 1-1 nếu không còn chung Workspace nào
   */
  private async processOneToOneArchiving(userIds: string[]) {
    // Sử dụng gRPC CheckSharedWorkspaces để kiểm tra chéo
    for (let i = 0; i < userIds.length; i++) {
      for (let j = i + 1; j < userIds.length; j++) {
        const u1 = userIds[i];
        const u2 = userIds[j];

        const { hasSharedActiveWorkspace } = await messagingGrpc.checkSharedWorkspaces(u1, u2);

        if (!hasSharedActiveWorkspace) {
          await messagingGrpc.archiveOneToOneChat(u1, u2);
        }
      }
    }
  }

  /**
   * Luồng 6: Khôi Phục Workspace
   */
  async restoreWorkspace(workspaceId: string, userId: string) {
    const workspace = await messagingGrpc.getWorkspaceMetadata(workspaceId);
    if (!workspace) throw new Error('Không tìm thấy Workspace!');

    if (workspace.status !== 'DISSOLVED') throw new Error('Workspace không ở trạng thái bị giải tán!');

    // Kiểm tra thời gian lưu trữ
    const dissolvedAt = workspace.dissolvedAt ? new Date(workspace.dissolvedAt) : null;
    if (dissolvedAt) {
      const expiryDate = new Date(dissolvedAt);
      expiryDate.setDate(expiryDate.getDate() + (workspace.retentionDays || 30));

      if (new Date() > expiryDate) {
        throw new Error('Workspace đã quá hạn lưu trữ và không thể khôi phục.');
      }
    }

    try {
      // Gọi Messaging service để khôi phục
      await messagingGrpc.restoreWorkspace(workspaceId, userId);

      // Lấy danh sách thành viên để notify realtime
      const members = await messagingGrpc.getWorkspaceMembers(workspaceId);

      await publishEvent(EventSubjects.WORKSPACE_RESTORED, {
        workspaceId,
        name: workspace.name,
        restoredBy: userId,
        memberIds: members,
        timestamp: new Date().toISOString()
      });

      logger.info({ workspaceId, restoredBy: userId }, 'Workspace restoration orchestrated successfully');
      return { success: true, message: 'Workspace đã được khôi phục thành công.' };
    } catch (error) {
      logger.error({ error, workspaceId }, 'Error during workspace restoration orchestration');
      throw error;
    }
  }
}

export const workspaceDissolutionService = new WorkspaceDissolutionService();
