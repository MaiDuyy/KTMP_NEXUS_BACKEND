import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { userService } from './services/user.service.js';
import { friendService } from './services/friend.service.js';
import { logger } from './lib/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Thử nhiều đường dẫn để tương thích cả Dev và Docker
const pathsToTry = [
  path.resolve(__dirname, '../../../protos/user.proto'), // Dev (src/...)
  path.resolve(__dirname, '../../protos/user.proto'),    // Docker (dist/...)
  path.resolve(process.cwd(), 'protos/user.proto'),      // Docker root
];

const PROTO_PATH = pathsToTry.find(p => fs.existsSync(p)) || pathsToTry[0];

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const userProto = (grpc.loadPackageDefinition(packageDefinition) as any).user;

export function startGrpcServer() {
  const server = new grpc.Server();

  server.addService(userProto.UserService.service, {
    GetUsersBatch: async (call: any, callback: any) => {
      try {
        const { ids } = call.request;
        const users = await userService.getUsersByIds(ids);
        
        callback(null, { users: users.map(u => ({
          id: u.id,
          name: u.name,
          email: (u as any).email || '',
          avatar: u.avatar || '',
          status: u.status || '',
          isOnline: u.isOnline || false,
          userStatus: u.userStatus || ''
        })) });
      } catch (err) {
        logger.error({ err }, 'gRPC getUsersBatch failed');
        callback(err);
      }
    },

    CheckBlocked: async (call: any, callback: any) => {
      try {
        const { user1Id, user2Id } = call.request;
        const result = await friendService.checkBlockedStatus(user1Id, user2Id);
        callback(null, { 
          isBlocked: result.isBlocked,
          blockerId: result.blockerId || ''
        });
      } catch (err) {
        logger.error({ err }, 'gRPC checkBlocked failed');
        callback(err);
      }
    },
    
    CheckFriendship: async (call: any, callback: any) => {
      try {
        const { user1Id, user2Id } = call.request;
        const isFriend = await friendService.checkFriendship(user1Id, user2Id);
        callback(null, { isFriend });
      } catch (err) {
        logger.error({ err }, 'gRPC checkFriendship failed');
        callback(err);
      }
    },
    
    GetUserByEmail: async (call: any, callback: any) => {
      try {
        const { email } = call.request;
        const user = await userService.getUserByEmail(email);
        
        if (!user) {
          callback(null, {}); // Return empty if not found
          return;
        }

        callback(null, {
          id: user.id,
          name: user.name,
          email: user.email,
          avatar: user.avatar || '',
          status: user.status || '',
          isOnline: user.isOnline || false,
          userStatus: user.userStatus || ''
        });
      } catch (err) {
        logger.error({ err }, 'gRPC getUserByEmail failed');
        callback(err);
      }
    },

    GetAllUserIds: async (call: any, callback: any) => {
      try {
        const users = await userService.getAllUserIds();
        callback(null, { ids: users });
      } catch (err) {
        logger.error({ err }, 'gRPC getAllUserIds failed');
        callback(err);
      }
    },
    
    ValidateWorkspaceQuota: async (call: any, callback: any) => {
      try {
        const { userId } = call.request;
        const result = await userService.validateWorkspaceQuota(userId);
        callback(null, result);
      } catch (err) {
        logger.error({ err }, 'gRPC validateWorkspaceQuota failed');
        callback(err);
      }
    }
  });

  const GRPC_PORT = process.env.IDENTITY_GRPC_PORT || '50051';

  server.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      logger.error({ err }, 'Failed to bind gRPC server');
      return;
    }
    logger.info(`gRPC Server running at 0.0.0.0:${port}`);
  });
}
