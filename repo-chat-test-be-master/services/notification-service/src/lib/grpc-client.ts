import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pathsToTry = [
  path.resolve(__dirname, '../../../../protos/user.proto'),
  path.resolve(__dirname, '../../../protos/user.proto'),
  path.resolve(process.cwd(), 'protos/user.proto'),
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

const IDENTITY_GRPC_URL = process.env.IDENTITY_SERVICE_GRPC_URL || 'localhost:50051';

export const identityClient = new userProto.UserService(
  IDENTITY_GRPC_URL,
  grpc.credentials.createInsecure()
);

export const getAllUserIds = (): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    identityClient.GetAllUserIds({}, (err: any, response: any) => {
      if (err) {
        logger.error({ err }, 'gRPC GetAllUserIds failed');
        return reject(err);
      }
      resolve(response.ids || []);
    });
  });
};
