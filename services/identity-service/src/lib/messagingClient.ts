import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getProtoPath(relativeToProject: string) {
  const paths = [
    path.resolve(__dirname, `../../../../protos/${relativeToProject}`),
    path.resolve(__dirname, `../../../protos/${relativeToProject}`),
    path.resolve(process.cwd(), `protos/${relativeToProject}`),
  ];
  return paths.find(p => fs.existsSync(p)) || paths[0];
}

const workspacePackageDef = protoLoader.loadSync(getProtoPath('workspace.proto'), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});

const workspaceProto = (grpc.loadPackageDefinition(workspacePackageDef) as any).workspace;

const MESSAGING_GRPC_HOST = process.env.MESSAGING_GRPC_HOST || 'localhost';
const MESSAGING_GRPC_PORT = process.env.MESSAGING_GRPC_PORT || '50052';

export const messagingClient = new workspaceProto.WorkspaceService(
  `${MESSAGING_GRPC_HOST}:${MESSAGING_GRPC_PORT}`,
  grpc.credentials.createInsecure()
);

export const messagingGrpc = {
  dissolveWorkspace: (workspaceId: string, userId: string, workspaceNameConfirm: string): Promise<{ success: boolean }> => {
    return new Promise((resolve, reject) => {
      messagingClient.DissolveWorkspace({ workspaceId, userId, workspaceNameConfirm }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  restoreWorkspace: (workspaceId: string, userId: string): Promise<{ success: boolean }> => {
    return new Promise((resolve, reject) => {
      messagingClient.RestoreWorkspace({ workspaceId, userId }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  getWorkspaceMetadata: (workspaceId: string): Promise<any> => {
    return new Promise((resolve, reject) => {
      messagingClient.GetWorkspaceMetadata({ workspaceId }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  getWorkspaceMembers: (workspaceId: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      messagingClient.GetWorkspaceMembers({ workspaceId }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response.userIds);
      });
    });
  },

  checkSharedWorkspaces: (user1Id: string, user2Id: string): Promise<{ hasSharedActiveWorkspace: boolean; sharedCount: number }> => {
    return new Promise((resolve, reject) => {
      messagingClient.CheckSharedWorkspaces({ user1Id, user2Id }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  getUserDMPartners: (userId: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      messagingClient.GetUserDMPartners({ userId }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response.partnerIds);
      });
    });
  },

  leaveWorkspace: (workspaceId: string, userId: string): Promise<{ success: boolean }> => {
    return new Promise((resolve, reject) => {
      messagingClient.LeaveWorkspace({ workspaceId, userId }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  kickMember: (workspaceId: string, targetUserId: string, actorId: string): Promise<{ success: boolean }> => {
    return new Promise((resolve, reject) => {
      messagingClient.KickMember({ workspaceId, targetUserId, actorId }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  archiveOneToOneChat: (user1Id: string, user2Id: string): Promise<{ success: boolean }> => {
    return new Promise((resolve, reject) => {
      messagingClient.ArchiveOneToOneChat({ user1Id, user2Id }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  getExpiredDissolvedWorkspaces: (): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      messagingClient.GetExpiredDissolvedWorkspaces({}, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response.workspaceIds);
      });
    });
  },

  deleteWorkspacePermanently: (workspaceId: string): Promise<{ success: boolean }> => {
    return new Promise((resolve, reject) => {
      messagingClient.DeleteWorkspacePermanently({ workspaceId }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },

  getWorkspaceCount: (ownerId: string): Promise<number> => {
    return new Promise((resolve, reject) => {
      messagingClient.GetWorkspaceCount({ ownerId }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response.count);
      });
    });
  },
  addMember: (workspaceId: string, userId: string, role: string, invitedBy?: string): Promise<{ success: boolean; message: string }> => {
    return new Promise((resolve, reject) => {
      messagingClient.AddMember({ workspaceId, userId, role, invitedBy: invitedBy || '' }, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  },
  getAdminStats: (): Promise<any> => {
    return new Promise((resolve, reject) => {
      messagingClient.GetAdminStats({}, (err: any, response: any) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  }
};
