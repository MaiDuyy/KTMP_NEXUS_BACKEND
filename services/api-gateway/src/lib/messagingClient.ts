import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find the workspace.proto file
const pathsToTry = [
  path.resolve(__dirname, '../../../../protos/workspace.proto'), // Dev
  path.resolve(__dirname, '../../../protos/workspace.proto'),    // Docker
  path.resolve(process.cwd(), 'protos/workspace.proto'),        // Root
];
const PROTO_PATH = pathsToTry.find(p => fs.existsSync(p)) || pathsToTry[0];

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});

const workspaceProto = (grpc.loadPackageDefinition(packageDefinition) as any).workspace;

const MESSAGING_GRPC_HOST = process.env.MESSAGING_GRPC_HOST || 'localhost';
const MESSAGING_GRPC_PORT = process.env.MESSAGING_GRPC_PORT || '50052';

const client = new workspaceProto.WorkspaceService(
  `${MESSAGING_GRPC_HOST}:${MESSAGING_GRPC_PORT}`,
  grpc.credentials.createInsecure()
);

export const messagingClient = {
  getMemberRole: (userId: string, workspaceId: string): Promise<{ isMember: boolean; role: string }> => {
    return new Promise((resolve, reject) => {
      client.GetMemberRole({ userId, workspaceId }, (err: any, response: any) => {
        if (err) {
          logger.error({ err, userId, workspaceId }, 'gRPC GetMemberRole failed');
          return reject(err);
        }
        resolve(response);
      });
    });
  }
};
