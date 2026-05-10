import { messagingGrpc } from '../lib/messagingClient.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export class WorkspaceService {
  /**
   * Luồng 4: Tự rời Workspace
   */
  async leaveWorkspace(workspaceId: string, userId: string) {
    try {
      await messagingGrpc.leaveWorkspace(workspaceId, userId);
      
      // Xử lý archive chat 1-1 nếu không còn chung workspace nào
      // Chú ý: Đây là logic orchestrator của Identity service
      await this.checkAndArchiveDMs(userId);

      const members = await messagingGrpc.getWorkspaceMembers(workspaceId);
      await publishEvent(EventSubjects.WORKSPACE_MEMBER_LEFT, {
        workspaceId,
        userId,
        memberIds: members,
        reason: 'SELF_LEFT'
      });

      return { success: true, message: 'Đã rời khỏi Workspace.' };
    } catch (error) {
      logger.error({ error, workspaceId, userId }, 'Error during leaveWorkspace orchestration');
      throw error;
    }
  }

  /**
   * Luồng 5: Kick thành viên
   */
  async kickMember(workspaceId: string, targetUserId: string, actorId: string) {
    try {
      await messagingGrpc.kickMember(workspaceId, targetUserId, actorId);

      // Xử lý archive chat 1-1 cho người bị kick
      await this.checkAndArchiveDMs(targetUserId);

      const members = await messagingGrpc.getWorkspaceMembers(workspaceId);
      await publishEvent(EventSubjects.WORKSPACE_MEMBER_KICKED, {
        workspaceId,
        userId: targetUserId,
        memberIds: members,
        reason: 'KICKED',
        kickedBy: actorId
      });

      return { success: true, message: 'Đã xóa thành viên khỏi Workspace.' };
    } catch (error) {
      logger.error({ error, workspaceId, targetUserId }, 'Error during kickMember orchestration');
      throw error;
    }
  }

  /**
   * Kiểm tra và lưu trữ DM của một User nếu họ không còn chung workspace với ai đó
   */
  private async checkAndArchiveDMs(userId: string) {
    try {
      // 1. Lấy danh sách những người user này đang có DM
      const partnerIds = await messagingGrpc.getUserDMPartners(userId);
      
      for (const partnerId of partnerIds) {
        // 2. Kiểm tra xem 2 người còn chung workspace ACTIVE nào không
        const { hasSharedActiveWorkspace } = await messagingGrpc.checkSharedWorkspaces(userId, partnerId);
        
        if (!hasSharedActiveWorkspace) {
          // 3. Nếu không còn chung workspace, archive chat 1-1
          await messagingGrpc.archiveOneToOneChat(userId, partnerId);
          logger.info({ userId, partnerId }, 'Archived 1-1 chat due to no shared active workspaces');
        }
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error in checkAndArchiveDMs');
    }
  }
}

export const workspaceService = new WorkspaceService();
