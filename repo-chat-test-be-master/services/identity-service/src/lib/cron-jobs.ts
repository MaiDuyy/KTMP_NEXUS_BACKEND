import cron from 'node-cron';
import { messagingGrpc } from './messagingClient.js';
import { logger } from './logger.js';

/**
 * Cron job chạy mỗi ngày vào lúc 00:00
 * Quét các Workspace đã Dissolved và quá hạn Retention để Hard Delete
 */
export const startCronJobs = () => {
  // 0 0 * * * -> Chạy vào nửa đêm mỗi ngày
  cron.schedule('0 0 * * *', async () => {
    logger.info('Running workspace cleanup cron job...');
    
    try {
      // 1. Lấy danh sách workspace đã hết hạn từ Messaging Service
      const expiredIds = await messagingGrpc.getExpiredDissolvedWorkspaces();
      
      if (expiredIds.length === 0) {
        logger.info('No expired workspaces found for cleanup.');
        return;
      }

      logger.info({ count: expiredIds.length }, 'Found expired workspaces to delete');

      // 2. Thực hiện hard delete từng workspace qua gRPC
      for (const workspaceId of expiredIds) {
        try {
          await messagingGrpc.deleteWorkspacePermanently(workspaceId);
          logger.info({ workspaceId }, 'Permanently deleted expired workspace');
        } catch (err) {
          logger.error({ err, workspaceId }, 'Failed to delete expired workspace');
        }
      }
      
      logger.info('Workspace cleanup cron job finished.');
    } catch (error) {
      logger.error({ error }, 'Error in workspace cleanup cron job');
    }
  });

  logger.info('Cron jobs initialized');
};
