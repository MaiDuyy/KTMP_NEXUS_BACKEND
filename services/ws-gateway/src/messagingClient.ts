import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Proto paths
const pathsToTry = [
  path.resolve(__dirname, '../../../protos/group.proto'),
  path.resolve(__dirname, '../../protos/group.proto'),
  path.resolve(process.cwd(), 'protos/group.proto'),
];

const PROTO_PATH = pathsToTry.find(p => fs.existsSync(p)) || pathsToTry[0];

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const groupProto = (grpc.loadPackageDefinition(packageDefinition) as any).group;

const MESSAGING_GRPC_HOST = process.env.MESSAGING_GRPC_HOST || 'localhost';
const MESSAGING_GRPC_PORT = process.env.MESSAGING_GRPC_PORT || '50052';

const client = new groupProto.GroupService(
  `${MESSAGING_GRPC_HOST}:${MESSAGING_GRPC_PORT}`,
  grpc.credentials.createInsecure()
);

export const messagingGrpcClient = {
  getChat: (chatId: string): Promise<any> => {
    return new Promise((resolve, reject) => {
      client.getChat({ chat_id: chatId }, (err: any, response: any) => {
        if (err) {
          console.error('[messagingGrpcClient] getChat failed:', err);
          return reject(err);
        }
        resolve(response.chat);
      });
    });
  },
  
  getParticipantIds: async (chatId: string): Promise<string[]> => {
    try {
      const chat = await messagingGrpcClient.getChat(chatId);
      return chat.participant_ids || [];
    } catch (err) {
      return [];
    }
  }
};
