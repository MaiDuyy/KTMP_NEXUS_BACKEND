import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chatService } from './services/chat.service.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATHS = {
  group: path.resolve(process.cwd(), '../../protos/group.proto'),
  workspace: path.resolve(process.cwd(), '../../protos/workspace.proto'),
};

// Function to find the correct absolute path (handling Dev vs Docker)
function getProtoPath(relativeToProject: string) {
  const paths = [
    path.resolve(__dirname, `../../../protos/${relativeToProject}`),
    path.resolve(__dirname, `../../protos/${relativeToProject}`),
    path.resolve(process.cwd(), `protos/${relativeToProject}`),
  ];
  return paths.find(p => fs.existsSync(p)) || paths[0];
}

const groupPackageDef = protoLoader.loadSync(getProtoPath('group.proto'), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const workspacePackageDef = protoLoader.loadSync(getProtoPath('workspace.proto'), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});

const groupProto = (grpc.loadPackageDefinition(groupPackageDef) as any).group;
const workspaceProto = (grpc.loadPackageDefinition(workspacePackageDef) as any).workspace;

import { workspaceService } from './services/workspace.service.js';

export function startGrpcServer() {
  const server = new grpc.Server();

  server.addService(groupProto.GroupService.service, {
    getChat: async (call: any, callback: any) => {
      try {
        const { chat_id } = call.request;
        const chat = await chatService.getChatMetadataInternal(chat_id);
        
        if (!chat) {
          return callback({
            code: grpc.status.NOT_FOUND,
            message: 'Chat not found',
          });
        }

        callback(null, {
          chat: {
            id: chat.id,
            name: chat.name || '',
            avatar: chat.avatar || '',
            is_group: chat.isGroup,
            participant_ids: chat.participants.map((p: any) => p.accountId),
            participant_count: chat.participantCount,
            updated_at: chat.updatedAt.toISOString(),
            created_at: chat.createdAt.toISOString(),
            workspace_id: chat.workspaceId || undefined
          }
        });
      } catch (err) {
        logger.error({ err }, 'gRPC getChat failed');
        callback(err);
      }
    },
  });

  server.addService(workspaceProto.WorkspaceService.service, {
    GetMemberRole: async (call: any, callback: any) => {
      try {
        const { userId, workspaceId } = call.request;
        const member = await workspaceService.checkMembership(workspaceId, userId);
        
        if (!member) {
          return callback(null, { isMember: false, role: '' });
        }

        callback(null, {
          isMember: true,
          role: member.role
        });
      } catch (err) {
        logger.error({ err }, 'gRPC GetMemberRole failed');
        callback(err);
      }
    },
    DissolveWorkspace: async (call: any, callback: any) => {
      try {
        const { workspaceId, userId, workspaceNameConfirm } = call.request;
        await workspaceService.dissolveWorkspace(workspaceId, userId, workspaceNameConfirm);
        callback(null, { success: true });
      } catch (err) {
        logger.error({ err }, 'gRPC DissolveWorkspace failed');
        callback(err);
      }
    },
    RestoreWorkspace: async (call: any, callback: any) => {
      try {
        const { workspaceId, userId } = call.request;
        await workspaceService.restoreWorkspace(workspaceId, userId);
        callback(null, { success: true });
      } catch (err) {
        logger.error({ err }, 'gRPC RestoreWorkspace failed');
        callback(err);
      }
    },
    GetWorkspaceMetadata: async (call: any, callback: any) => {
      try {
        const { workspaceId } = call.request;
        const meta = await workspaceService.getWorkspaceMetadata(workspaceId);
        if (!meta) return callback({ code: grpc.status.NOT_FOUND, message: 'Workspace not found' });
        callback(null, {
          id: meta.id,
          name: meta.name,
          status: meta.status,
          ownerId: meta.ownerId,
          dissolvedAt: meta.dissolvedAt?.toISOString() || '',
          retentionDays: meta.retentionDays,
          slug: meta.slug
        });
      } catch (err) {
        logger.error({ err }, 'gRPC GetWorkspaceMetadata failed');
        callback(err);
      }
    },
    GetWorkspaceMembers: async (call: any, callback: any) => {
      try {
        const { workspaceId } = call.request;
        const userIds = await workspaceService.getWorkspaceMembers(workspaceId);
        callback(null, { userIds });
      } catch (err) {
        logger.error({ err }, 'gRPC GetWorkspaceMembers failed');
        callback(err);
      }
    },
    AddMember: async (call: any, callback: any) => {
      try {
        const { workspaceId, userId, role, invitedBy } = call.request;
        // Map role if needed or use directly
        await workspaceService.addMember(workspaceId, userId, role as any, invitedBy || undefined);
        callback(null, { success: true, message: 'Member added successfully' });
      } catch (err: any) {
        logger.error({ err, request: call.request }, 'gRPC AddMember failed');
        callback(null, { success: false, message: err.message || 'Failed to add member' });
      }
    },
    CheckSharedWorkspaces: async (call: any, callback: any) => {
      try {
        const { user1Id, user2Id } = call.request;
        const result = await workspaceService.checkSharedActiveWorkspace(user1Id, user2Id);
        callback(null, result);
      } catch (err) {
        logger.error({ err }, 'gRPC CheckSharedWorkspaces failed');
        callback(err);
      }
    },
    GetUserDMPartners: async (call: any, callback: any) => {
      try {
        const { userId } = call.request;
        const partnerIds = await workspaceService.getUserDMPartners(userId);
        callback(null, { partnerIds });
      } catch (err) {
        logger.error({ err }, 'gRPC GetUserDMPartners failed');
        callback(err);
      }
    },
    LeaveWorkspace: async (call: any, callback: any) => {
      try {
        const { workspaceId, userId } = call.request;
        await workspaceService.leaveWorkspace(workspaceId, userId);
        callback(null, { success: true });
      } catch (err) {
        logger.error({ err }, 'gRPC LeaveWorkspace failed');
        callback(err);
      }
    },
    KickMember: async (call: any, callback: any) => {
      try {
        const { workspaceId, targetUserId, actorId } = call.request;
        await workspaceService.kickMember(workspaceId, targetUserId, actorId);
        callback(null, { success: true });
      } catch (err) {
        logger.error({ err }, 'gRPC KickMember failed');
        callback(err);
      }
    },
    ArchiveOneToOneChat: async (call: any, callback: any) => {
      try {
        const { user1Id, user2Id } = call.request;
        const success = await workspaceService.archiveOneToOneChat(user1Id, user2Id);
        callback(null, { success });
      } catch (err) {
        logger.error({ err }, 'gRPC ArchiveOneToOneChat failed');
        callback(err);
      }
    },
    GetExpiredDissolvedWorkspaces: async (call: any, callback: any) => {
      try {
        const workspaceIds = await workspaceService.getExpiredDissolvedWorkspaces();
        callback(null, { workspaceIds });
      } catch (err) {
        logger.error({ err }, 'gRPC GetExpiredDissolvedWorkspaces failed');
        callback(err);
      }
    },
    DeleteWorkspacePermanently: async (call: any, callback: any) => {
      try {
        const { workspaceId } = call.request;
        await workspaceService.deletePermanently(workspaceId);
        callback(null, { success: true });
      } catch (err) {
        logger.error({ err }, 'gRPC DeleteWorkspacePermanently failed');
        callback(err);
      }
    },
    GetWorkspaceCount: async (call: any, callback: any) => {
      try {
        const { ownerId } = call.request;
        const count = await workspaceService.countWorkspacesByOwner(ownerId);
        callback(null, { count });
      } catch (err) {
        logger.error({ err }, 'gRPC GetWorkspaceCount failed');
        callback(err);
      }
    },
    GetAdminStats: async (call: any, callback: any) => {
      try {
        const [totalMessages, totalChats, totalTasks, activeTasks, totalWorkspaces, pendingInvitations] = await Promise.all([
          prisma.message.count(),
          prisma.chat.count(),
          prisma.task.count(),
          prisma.task.count({ where: { status: { not: 'DONE' } } }),
          prisma.workspace.count(),
          prisma.workspaceInvite.count({ where: { status: 'PENDING' } }),
        ]);

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const messageActivityRaw = await prisma.message.findMany({
          where: { time: { gte: sevenDaysAgo } },
          select: { time: true },
        });

        const activityMap = new Map<string, number>();
        messageActivityRaw.forEach(m => {
          const date = new Date(m.time).toISOString().split('T')[0];
          activityMap.set(date, (activityMap.get(date) || 0) + 1);
        });

        const messageActivity = Array.from(activityMap.entries())
          .map(([date, count]) => ({ date, count }))
          .sort((a, b) => a.date.localeCompare(b.date));

        callback(null, {
          success: true,
          totalMessages,
          totalChats,
          totalTasks,
          activeTasks,
          totalWorkspaces,
          pendingInvitations,
          messageActivity,
        });
      } catch (err) {
        logger.error({ err }, 'gRPC GetAdminStats failed');
        callback(err);
      }
    }
  });

  const GRPC_PORT = process.env.MESSAGING_GRPC_PORT || '50052';

  server.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      logger.error({ err }, 'Failed to bind Messaging gRPC server');
      return;
    }
    logger.info(`Messaging gRPC Server running at 0.0.0.0:${port}`);
  });
}
