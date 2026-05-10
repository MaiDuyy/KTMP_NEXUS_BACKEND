import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { redis } from './redis.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Thử nhiều đường dẫn để tương thích cả Dev và Docker
const pathsToTry = [
  path.resolve(__dirname, '../../../../protos/user.proto'), // Dev (src/lib/...)
  path.resolve(__dirname, '../../../protos/user.proto'),    // Docker (dist/lib/...)
  path.resolve(process.cwd(), 'protos/user.proto'),         // Docker root
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
const IDENTITY_HOST = process.env.IDENTITY_GRPC_HOST || 'localhost';
const IDENTITY_PORT = process.env.IDENTITY_GRPC_PORT || '50051';
const GRPC_HOST = `${IDENTITY_HOST}:${IDENTITY_PORT}`;

const client = new userProto.UserService(
  GRPC_HOST,
  grpc.credentials.createInsecure()
);

const CACHE_TTL = 3600; // 1 hour

export const userorgClient = {
    /**
     * Lấy profile người dùng (theo lô) kèm Cache Redis + gRPC
     */
    getUsers: async (ids: string[]): Promise<Map<string, any>> => {
        const accountMap = new Map<string, any>();
        if (!ids.length) return accountMap;

        const uniqueIds = [...new Set(ids)];
        const cacheKeys = uniqueIds.map(id => `user:profile:${id}`);

        try {
            // 1. Check Redis Cache
            const cachedProfiles = await redis.mget(...cacheKeys);
            const missingIds: string[] = [];

            cachedProfiles.forEach((profile, index) => {
                if (profile) {
                    accountMap.set(uniqueIds[index], JSON.parse(profile));
                } else {
                    missingIds.push(uniqueIds[index]);
                }
            });

            // 2. Fetch missing from Identity Service via gRPC
            if (missingIds.length > 0) {
                logger.info({ count: missingIds.length }, '[UserOrgClient] Fetching missing user profiles via gRPC');
                
                return new Promise((resolve) => {
                    client.GetUsersBatch({ ids: missingIds }, async (err: any, response: any) => {
                        if (err) {
                            logger.error({ err }, '[UserOrgClient] gRPC getUsersBatch failed');
                            resolve(accountMap); // Return what we have from cache
                            return;
                        }

                        if (response && response.users) {
                            const pipeline = redis.pipeline();
                            response.users.forEach((u: any) => {
                                accountMap.set(u.id, u);
                                pipeline.setex(`user:profile:${u.id}`, CACHE_TTL, JSON.stringify(u));
                            });
                            await pipeline.exec();
                        }
                        resolve(accountMap);
                    });
                });
            }
        } catch (error) {
            logger.error({ error }, '[UserOrgClient] Failed to fetch users');
        }

        return accountMap;
    },

    /**
     * Kiểm tra trạng thái chặn giữa 2 user qua gRPC
     */
    checkBlockedStatus: async (user1Id: string, user2Id: string): Promise<{ isBlocked: boolean; blockerId: string }> => {
        return new Promise((resolve) => {
            client.CheckBlocked({ user1Id, user2Id }, (err: any, response: any) => {
                if (err) {
                    logger.error({ err }, '[UserOrgClient] gRPC checkBlocked failed');
                    resolve({ isBlocked: false, blockerId: '' });
                    return;
                }
                resolve({ 
                  isBlocked: !!response.isBlocked, 
                  blockerId: response.blockerId || '' 
                });
            });
        });
    },
    
    /**
     * Tìm user theo email qua gRPC
     */
    getUserByEmail: async (email: string): Promise<any | null> => {
        return new Promise((resolve) => {
            client.GetUserByEmail({ email }, (err: any, response: any) => {
                if (err) {
                    logger.error({ err }, '[UserOrgClient] gRPC getUserByEmail failed');
                    resolve(null);
                    return;
                }
                if (response && response.id) {
                    resolve(response);
                } else {
                    resolve(null);
                }
            });
        });
    },
    
    /**
     * Kiểm tra quota workspace của user qua gRPC
     */
    validateWorkspaceQuota: async (userId: string): Promise<{ allowed: boolean; used: number; limit: number; orgId: string }> => {
        return new Promise((resolve) => {
            client.ValidateWorkspaceQuota({ userId }, (err: any, response: any) => {
                if (err) {
                    logger.error({ err }, '[UserOrgClient] gRPC validateWorkspaceQuota failed');
                    resolve({ allowed: false, used: 0, limit: 0, orgId: '' });
                    return;
                }
                resolve(response);
            });
        });
    }
};
