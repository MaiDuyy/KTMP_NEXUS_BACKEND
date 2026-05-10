import { connect, NatsConnection, JSONCodec, Subscription , StringCodec} from 'nats';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

export const EventSubjects = {
  // User events from auth-service
  USER_CREATED: 'user.created',
  FILE_UPLOADED: 'file.uploaded',
  // User events
  USER_UPDATED: 'user.updated',
  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',
  
  // Module 3: User Status (USER-03, USER-04)
  USER_STATUS_CHANGED: 'user.status.changed',
  
  // Module 3: Suspension (USER-08)
  USER_SUSPENDED: 'user.suspended',
  USER_UNSUSPENDED: 'user.unsuspended',
  
  // Module 3: Deletion (USER-09)
  USER_DELETED: 'user.deleted',
  USER_ANONYMIZED: 'user.anonymized',
  
  // Module 3: Invitation (USER-07, USER-10)
  INVITATION_CREATED: 'invitation.created',
  INVITATION_ACCEPTED: 'invitation.accepted',
  
  // Module 3: Org Settings (USER-12)
  ORG_SETTINGS_UPDATED: 'org.settings.updated',

  USER_AVATAR_UPDATED: 'user.avatar.updated',
  
  // Friend events
  FRIEND_REQUEST_SENT: 'friend.request.sent',
  FRIEND_REQUEST_ACCEPTED: 'friend.request.accepted',
  FRIEND_REQUEST_REJECTED: 'friend.request.rejected',
  FRIEND_REQUEST_CANCELLED: 'friend.request.cancelled',
  FRIEND_UNFRIENDED: 'friend.unfriended',
  FRIEND_USER_BLOCKED: 'friend.user.blocked',
  FRIEND_USER_UNBLOCKED: 'friend.user.unblocked',
  
  // Phase 7: Audit logging
  AUDIT_LOG: 'audit.log',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects] | string;

// Role mapping from auth-service to userorg-service
type AuthRole = 'EMPLOYEE' | 'SUPER_ADMIN' | 'WORKSPACE_MANAGER' | 'ORG_ADMIN' | 'SECURITY_OFFICER' | 'KNOWLEDGE_ADMIN' | 'AI_ADMIN' | 'GUEST';
type UserOrgRole = 'USER' | 'ADMIN' | 'MODERATOR' | 'EMPLOYEE' | 'SUPER_ADMIN' | 'WORKSPACE_MANAGER';

function mapAuthRoleToUserOrgRole(authRole: AuthRole): UserOrgRole {
  const roleMap: Record<AuthRole, UserOrgRole> = {
    'SUPER_ADMIN': 'SUPER_ADMIN',
    'ORG_ADMIN': 'ADMIN',
    'SECURITY_OFFICER': 'MODERATOR',
    'WORKSPACE_MANAGER': 'WORKSPACE_MANAGER',
    'KNOWLEDGE_ADMIN': 'MODERATOR',
    'AI_ADMIN': 'MODERATOR',
    'EMPLOYEE': 'EMPLOYEE',
    'GUEST': 'USER',
  };
  return roleMap[authRole] || 'EMPLOYEE';
}

export async function connectNats(): Promise<NatsConnection> {
  if (natsConnection) return natsConnection;

  natsConnection = await connect({
    servers: process.env.NATS_URL || 'nats://localhost:4222',
    name: 'userorg-service',
    reconnect: true,
    maxReconnectAttempts: 10,
  });

  logger.info('NATS connected');
  return natsConnection;
}

export function getNatsConnection(): NatsConnection | null {
  return natsConnection;
}

export async function disconnectNats(): Promise<void> {
  if (natsConnection) {
    await natsConnection.drain();
    natsConnection = null;
    logger.info('NATS disconnected');
  }
}

export async function publishEvent<T>(subject: EventSubject, payload: T): Promise<void> {
  if (!natsConnection) return;
  natsConnection.publish(
    subject,
    jsonCodec.encode({ subject, payload, timestamp: new Date().toISOString() })
  );
}

interface AuthUserPayload {
  id: string;
  email: string;
  name: string;
  number: string;
  gender: string;
  birthDate: string | null;
  location: string | null;
  role: any; // Thay bằng type AuthRole của bạn
  createdAt?: string;
  updatedAt?: string;
}

// Hàm khởi tạo lắng nghe events
export async function subscribeToAuthEvents(): Promise<Subscription[]> {
  if (!natsConnection) {
    logger.warn('NATS not connected, cannot subscribe to auth events');
    return [];
  }

  const jsonCodec = JSONCodec();
  const subscriptions: Subscription[] = [];
  
  // Danh sách các event cần lắng nghe
  const subjects = [EventSubjects.USER_CREATED, EventSubjects.USER_UPDATED];

  // Lặp qua từng event và đăng ký
  for (const subject of subjects) {
    const sub = natsConnection.subscribe(subject);
    subscriptions.push(sub);
    logger.info(`Subscribed to ${subject} events`);

    // Chạy một async IIFE (Immediately Invoked Function Expression) để xử lý stream tin nhắn liên tục
    (async () => {
      for await (const msg of sub) {
        try {
          // Decode dữ liệu gửi từ Auth Service
          const data = jsonCodec.decode(msg.data) as { payload: AuthUserPayload };
          const userPayload = data.payload;
          
          // Map role
          const mappedRole = mapAuthRoleToUserOrgRole(userPayload.role);

          // Sử dụng UPSERT:
          // - Nếu nhận được USER_CREATED (chưa có ID này trong DB): Chạy block `create`
          // - Nếu nhận được USER_UPDATED (hoặc USER_CREATED bị gửi lặp, đã có ID): Chạy block `update`
          await prisma.account.upsert({
            where: { id: userPayload.id },
            update: {
              email: userPayload.email,
              name: userPayload.name,
              number: userPayload.number,
              gender: userPayload.gender,
              birthDate: userPayload.birthDate ? new Date(userPayload.birthDate) : null,
              location: userPayload.location,
              role: mappedRole,
              updatedAt: new Date(),
            },
            create: {
              id: userPayload.id,
              email: userPayload.email,
              name: userPayload.name,
              number: userPayload.number,
              password: '', // Org service không cần lưu/xử lý mật khẩu
              gender: userPayload.gender,
              birthDate: userPayload.birthDate ? new Date(userPayload.birthDate) : null,
              location: userPayload.location,
              role: mappedRole,
              isVerified: false,
              isOnline: false,
              isAnonymized: false, // Thêm flag này cho chắc chắn user đang active
            },
          });

          logger.info(
            { userId: userPayload.id, event: subject }, 
            `User successfully synced via ${subject}`
          );

        } catch (err) {
          // Bắt lỗi an toàn, in ra raw data nếu decode lỗi để dễ debug
          const sc = StringCodec();
          logger.error(
            { 
              error: err, 
              subject, 
              rawData: sc.decode(msg.data) 
            }, 
            `Failed to process event ${subject}`
          );
        }
      }
    })();
  }

  // Trả về mảng sub để dùng cho graceful shutdown sau này
  return subscriptions;
}
