// services/ws-gateway/src/index.ts
// WebSocket Gateway - Full Call Signaling + Chat Realtime

import 'dotenv/config';
import http from 'http';
import express from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { connect, NatsConnection, JSONCodec } from 'nats';
import { AccessToken } from 'livekit-server-sdk';
import { createInternalSignature } from '@ott/shared';
import { messagingGrpcClient } from './messagingClient.js';

const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'dev-internal-secret-change-in-production';

const app = express();
const httpServer = http.createServer(app);

// Config
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';

// LiveKit Config
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880';

// ============= TYPES =============

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userName?: string;
}

// Map lưu trữ users đang online
const onlineUsers = new Map<string, Set<string>>();
// Khắc phục F5: Map lưu trữ timeout để trì hoãn việc đánh dấu offline
const disconnectTimeouts = new Map<string, NodeJS.Timeout>();

// NATS
let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();

const EventSubjects = {
  MESSAGE_CREATED: 'message.created',
  MESSAGE_READ: 'message.read',
  MESSAGE_REACTION: 'message.reaction',
  MESSAGE_DELETED: 'message.deleted',
  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',
  TYPING_START: 'typing.start',
  TYPING_STOP: 'typing.stop',
  USER_AVATAR_UPDATED: 'user.avatar.updated',
  GROUP_MEMBER_ROLE_UPDATED: 'group.member.role.updated',
  GROUP_DELETED: 'group.deleted',
  GROUP_MEMBER_REMOVED: 'group.member.removed',
  FRIEND_REQUEST_SENT: 'friend.request.sent',
  FRIEND_REQUEST_ACCEPTED: 'friend.request.accepted',
  FRIEND_REQUEST_REJECTED: 'friend.request.rejected',
  FRIEND_REQUEST_CANCELLED: 'friend.request.cancelled',
  FRIEND_UNFRIENDED: 'friend.unfriended',
  FRIEND_USER_BLOCKED: 'friend.user.blocked',
  FRIEND_USER_UNBLOCKED: 'friend.user.unblocked',
};

// ============= CALL STATE =============

interface ActiveCall {
  callerId: string;
  callerName: string;
  chatId: string;
  isVideo: boolean;
  callType: 'private' | 'group';
  status: 'ringing' | 'active' | 'ended';
  createdAt: Date;
  // Private call: single callee
  calleeId?: string;
  // Group call: set of participants currently in the room
  participants: Set<string>;
}

// Track active calls: roomName -> call metadata
const activeCalls = new Map<string, ActiveCall>();

// Track which user is currently in a call: userId -> roomName
const userInCall = new Map<string, string>();

// Auto-expire ringing calls after 30 seconds
const RINGING_TIMEOUT_MS = 30_000;
const ringingTimeouts = new Map<string, NodeJS.Timeout>();

// ============= CALL HELPERS =============

function generateRoomName(chatId: string): string {
  return `call_${chatId}_${Date.now()}`;
}

async function generateLiveKitToken(userId: string, userName: string, roomName: string): Promise<string> {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userId,
    name: userName,
    ttl: '1h',
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });
  return await at.toJwt();
}

/** Full cleanup: remove ALL participants from call, delete room */
function cleanupCall(roomName: string) {
  const call = activeCalls.get(roomName);
  if (call) {
    // Notify chat that call ended
    io.to(`chat:${call.chatId}`).emit('chat:call_status', {
      chatId: call.chatId,
      roomName: null,
      isActive: false,
    });

    // Remove every participant from userInCall
    call.participants.forEach((uid) => userInCall.delete(uid));
    if (call.callerId) userInCall.delete(call.callerId);
    if (call.calleeId) userInCall.delete(call.calleeId);
  }
  
  activeCalls.delete(roomName);
  
  const timeout = ringingTimeouts.get(roomName);
  if (timeout) {
    clearTimeout(timeout);
    ringingTimeouts.delete(roomName);
  }
  console.log(`[Call] Cleaned up room: ${roomName}`);
}

/** Remove a single participant from a group call. Returns true if room is now empty. */
function removeParticipant(roomName: string, participantId: string): boolean {
  const call = activeCalls.get(roomName);
  if (!call) return true;
  call.participants.delete(participantId);
  userInCall.delete(participantId);
  console.log(`[Call] ${participantId} left room ${roomName}. Remaining: ${call.participants.size}`);
  return call.participants.size === 0;
}

/**
 * Save a call event as a message in chat history.
 * This creates a system-style message visible in the conversation timeline.
 */
async function saveCallEventMessage(
  chatId: string,
  callerId: string,
  messageType: 'call_ended' | 'call_missed' | 'call_declined' | 'call_cancelled',
  metadata: { isVideo: boolean; duration?: number; callerName?: string }
) {
  try {
    // UNIFIED: Now points to messaging-service instead of chat-service
    const messagingServiceUrl = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3020';
    const content = JSON.stringify(metadata);
    
    // Create HMAC signature
    const signature = createInternalSignature(INTERNAL_SERVICE_SECRET, {
      userId: callerId,
      role: 'USER', // default fallback for ws-gateway proxy
    });

    await fetch(`${messagingServiceUrl}/messages/${chatId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': callerId,
        'x-user-name': metadata.callerName || 'System',
        'x-internal-signature': signature,
      },
      body: JSON.stringify({ content, type: messageType }),
    });
    console.log(`[Call] Saved ${messageType} message in chat ${chatId}`);
  } catch (error: any) {
    console.error(`[Call] Failed to save call event message:`, error.message);
  }
}

// ============= HEALTH CHECK =============

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ws-gateway',
    connections: io?.engine?.clientsCount || 0,
    onlineUsers: onlineUsers.size,
    activeCalls: activeCalls.size,
    timestamp: new Date().toISOString(),
  });
});

// ============= SOCKET.IO SETUP =============

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: CORS_ORIGIN.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

// ============= REDIS ADAPTER (Optional) =============

async function setupRedisAdapter() {
  try {
    const pubClient = new Redis(REDIS_URL);
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));
    console.log('[WS Gateway] Redis adapter connected');
  } catch (error) {
    console.warn('[WS Gateway] Redis adapter not available, using memory adapter');
  }
}

// ============= NATS SETUP =============

async function setupNats() {
  try {
    natsConnection = await connect({
      servers: NATS_URL,
      name: 'ws-gateway',
      reconnect: true,
      maxReconnectAttempts: 10,
    });

    console.log('[WS Gateway] NATS connected');
    subscribeToNatsEvents();
  } catch (error) {
    console.warn('[WS Gateway] NATS not available');
  }
}

function subscribeToNatsEvents() {
  if (!natsConnection) return;

  // Message Created -> Fan-out to each participant's personal room
  // We use ONLY personal rooms (user:${uid}) for delivery to guarantee
  // exactly-once per user. Using both chat rooms + personal rooms caused duplicates.
  const msgCreatedSub = natsConnection.subscribe(EventSubjects.MESSAGE_CREATED);
  (async () => {
    for await (const msg of msgCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, ...messageData } = event.payload;

      try {
        // UNIFIED: Now points to messaging-service instead of group-service
        const messagingServiceUrl = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3020';
        const signature = createInternalSignature(INTERNAL_SERVICE_SECRET, {
          userId: 'ws-gateway',
          role: 'SYSTEM',
        });
        const response = await fetch(`${messagingServiceUrl}/chats/internal/${chatId}/participant-ids`, {
          headers: {
            'x-internal-signature': signature,
            'x-user-id': 'ws-gateway',
            'x-user-role': 'SYSTEM',
          },
        });
        if (response.ok) {
          const data = await response.json() as any;
          if (Array.isArray(data?.participantIds)) {
            for (const uid of data.participantIds) {
              io.to(`user:${uid}`).emit('message:new', { message: messageData, chatId });
            }
          }
        } else {
          // Fallback: broadcast to chat room if group-service is unavailable
          io.to(`chat:${chatId}`).emit('message:new', { message: messageData, chatId });
        }
      } catch (err) {
        // Fallback: broadcast to chat room if group-service is unreachable
        console.warn('[WS] Fan-out failed, falling back to room broadcast:', (err as any).message);
        io.to(`chat:${chatId}`).emit('message:new', { message: messageData, chatId });
      }
    }
  })();


  // Message Read
  const msgReadSub = natsConnection.subscribe(EventSubjects.MESSAGE_READ);
  (async () => {
    for await (const msg of msgReadSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, userId, readAt, messageId } = event.payload;
      io.to(`chat:${chatId}`).emit('message:read', { chatId, userId, readAt, messageId });
    }
  })();

  // Message Reaction
  const msgReactSub = natsConnection.subscribe(EventSubjects.MESSAGE_REACTION);
  (async () => {
    for await (const msg of msgReactSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, ...reactionData } = event.payload;
      io.to(`chat:${chatId}`).emit('message:reacted', { chatId, ...reactionData });
    }
  })();

  // Message Deleted
  const msgDeletedSub = natsConnection.subscribe(EventSubjects.MESSAGE_DELETED);
  (async () => {
    for await (const msg of msgDeletedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, ...deleteData } = event.payload;
      io.to(`chat:${chatId}`).emit('message:recalled', { chatId, ...deleteData });
    }
  })();

  // Message Pinned
  const msgPinnedSub = natsConnection.subscribe('message.pinned');
  (async () => {
    for await (const msg of msgPinnedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, messageId, pin, userId, userName } = event.payload;
      io.to(`chat:${chatId}`).emit('message:pinned', { chatId, messageId, pin, userId, userName });
    }
  })();

  // Thread Reply Created
  const threadReplySub = natsConnection.subscribe('thread.reply.created');
  (async () => {
    for await (const msg of threadReplySub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, parentId, ...replyData } = event.payload;
      io.to(`chat:${chatId}`).emit('thread:reply', { chatId, parentId, reply: replyData });
      io.to(`thread:${parentId}`).emit('thread:reply', { parentId, reply: replyData });
    }
  })();

  // User Mentioned
  const userMentionedSub = natsConnection.subscribe('user.mentioned');
  (async () => {
    for await (const msg of userMentionedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, chatId, messageId, mentionedBy } = event.payload;
      io.to(`user:${userId}`).emit('mention:new', { chatId, messageId, mentionedBy, timestamp: event.timestamp });
    }
  })();

  // Mention Broadcast (@here, @channel)
  const mentionBroadcastSub = natsConnection.subscribe('mention.broadcast');
  (async () => {
    for await (const msg of mentionBroadcastSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, messageId, mentionedBy, types } = event.payload;
      io.to(`chat:${chatId}`).emit('mention:broadcast', { chatId, messageId, mentionedBy, types });
    }
  })();

  // Message Edited
  const msgEditedSub = natsConnection.subscribe('message.edited');
  (async () => {
    for await (const msg of msgEditedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, messageId, content, editedAt } = event.payload;
      io.to(`chat:${chatId}`).emit('message:edited', { chatId, messageId, content, editedAt });
    }
  })();

  // User Online
  const userOnlineSub = natsConnection.subscribe(EventSubjects.USER_ONLINE);
  (async () => {
    for await (const msg of userOnlineSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId } = event.payload;
      io.emit('user:online', { userId });
    }
  })();

  // User Offline
  const userOfflineSub = natsConnection.subscribe(EventSubjects.USER_OFFLINE);
  (async () => {
    for await (const msg of userOfflineSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, lastSeen } = event.payload;
      io.emit('user:offline', { userId, lastSeen });
    }
  })();

  // User Avatar Updated
  const userAvatarSub = natsConnection.subscribe(EventSubjects.USER_AVATAR_UPDATED);
  (async () => {
    for await (const msg of userAvatarSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, avatar } = event.payload;
      console.log(`[WS] Broadcasting avatar update for user: ${userId}`);
      io.emit('user:avatar:updated', { userId, avatar });
    }
  })();
  
  // Group Deleted
  const groupDeletedSub = natsConnection.subscribe(EventSubjects.GROUP_DELETED || 'group.deleted');
  (async () => {
    for await (const msg of groupDeletedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, memberIds } = event.payload;
      console.log(`[WS] Group deleted: ${chatId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('chat:deleted', { chatId });
        }
      }
    }
  })();

  // Group Member Removed (Kicked or Self Leave)
  const groupMemberRemovedSub = natsConnection.subscribe(EventSubjects.GROUP_MEMBER_REMOVED || 'group.member.removed');
  (async () => {
    for await (const msg of groupMemberRemovedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, memberId, isSelfLeave } = event.payload;
      console.log(`[WS] Member ${memberId} removed from chat ${chatId}. SelfLeave: ${isSelfLeave}`);
      // Notify the specific member they are out
      io.to(`user:${memberId}`).emit('chat:member_removed', { chatId, isSelfLeave });
      // Notify the chat room to update members list
      io.to(`chat:${chatId}`).emit('chat:member_updated', { chatId, memberId, action: 'removed' });
    }
  })();

  // Group Member Role Updated
  const groupMemberRoleUpdatedSub = natsConnection.subscribe(EventSubjects.GROUP_MEMBER_ROLE_UPDATED || 'group.member.role.updated');
  (async () => {
    for await (const msg of groupMemberRoleUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, memberId, newRole } = event.payload;
      console.log(`[WS] Member ${memberId} role updated to ${newRole} in chat ${chatId}`);
      // Notify the specific member
      io.to(`user:${memberId}`).emit('chat:role_updated', { chatId, newRole });
      // Notify the chat room
      io.to(`chat:${chatId}`).emit('chat:member_updated', { chatId, memberId, action: 'role_updated', newRole });
    }
  })();

  // Group Updated (Info/Policy)
  const groupUpdatedSub = natsConnection.subscribe(EventSubjects.GROUP_UPDATED || 'group.updated');
  (async () => {
    for await (const msg of groupUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, ...updateData } = event.payload;
      console.log(`[WS] Group ${chatId} updated`);
      io.to(`chat:${chatId}`).emit('chat:updated', { chatId, ...updateData });
    }
  })();

  // Group Member Added
  const groupMemberAddedSub = natsConnection.subscribe(EventSubjects.GROUP_MEMBER_ADDED || 'group.member.added');
  (async () => {
    for await (const msg of groupMemberAddedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, memberId, addedBy } = event.payload;
      console.log(`[WS] Member ${memberId} added to chat ${chatId}`);
      io.to(`chat:${chatId}`).emit('chat:member_updated', { chatId, memberId, action: 'added', addedBy });
    }
  })();

  // Join Request Created
  const groupJoinRequestCreatedSub = natsConnection.subscribe(EventSubjects.GROUP_JOIN_REQUEST_CREATED || 'group.join.request.created');
  (async () => {
    for await (const msg of groupJoinRequestCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, accountId, requestId } = event.payload;
      console.log(`[WS] New join request for chat ${chatId} from ${accountId}`);
      io.to(`chat:${chatId}`).emit('chat:join_request:new', { chatId, accountId, requestId });
    }
  })();

  // Join Request Updated
  const groupJoinRequestUpdatedSub = natsConnection.subscribe(EventSubjects.GROUP_JOIN_REQUEST_UPDATED || 'group.join.request.updated');
  (async () => {
    for await (const msg of groupJoinRequestUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, accountId, status, handledBy } = event.payload;
      console.log(`[WS] Join request for chat ${chatId} updated to ${status}`);
      io.to(`chat:${chatId}`).emit('chat:join_request:updated', { chatId, accountId, status, handledBy });
      // If approved, the member will be notified via group.member.added separately
    }
  })();

  // Task Events
  const taskCreatedSub = natsConnection.subscribe(EventSubjects.TASK_CREATED);
  (async () => {
    for await (const msg of taskCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, ...taskData } = event.payload;
      console.log(`[WS] Task created in chat ${chatId}`);
      io.to(`chat:${chatId}`).emit('task:new', { chatId, ...taskData });
    }
  })();

  const taskUpdatedSub = natsConnection.subscribe(EventSubjects.TASK_UPDATED);
  (async () => {
    for await (const msg of taskUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, taskId, ...updateData } = event.payload;
      console.log(`[WS] Task ${taskId} updated in chat ${chatId}`);
      io.to(`chat:${chatId}`).emit('task:updated', { chatId, taskId, ...updateData });
    }
  })();

  // Friend Request Sent
  const friendRequestSentSub = natsConnection.subscribe(EventSubjects.FRIEND_REQUEST_SENT || 'friend.request.sent');
  (async () => {
    for await (const msg of friendRequestSentSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { requestId, senderId, receiverId, senderName, senderAvatar } = event.payload;
      
      const socketPayload = {
        id: requestId,
        sender: {
          id: senderId,
          name: senderName,
          avatar: senderAvatar
        },
        createdAt: event.timestamp || new Date().toISOString()
      };

      console.log(`[WS] Friend request ${requestId} from ${senderId} to ${receiverId}`);
      
      // Notify receiver
      io.to(`user:${receiverId}`).emit('friend:request:received', socketPayload);
      
      // Notify sender (for other tabs)
      io.to(`user:${senderId}`).emit('friend:request:sent', { requestId, receiverId });
    }
  })();

  // Friend Request Accepted
  const friendRequestAcceptedSub = natsConnection.subscribe(EventSubjects.FRIEND_REQUEST_ACCEPTED || 'friend.request.accepted');
  (async () => {
    for await (const msg of friendRequestAcceptedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { senderId, ...acceptData } = event.payload;
      console.log(`[WS] Friend request accepted by ${acceptData.receiverId}, notifying sender ${senderId}`);
      
      const socketPayload = {
        friendId: acceptData.receiverId,
        user: {
          id: acceptData.receiverId,
          name: acceptData.receiverName,
          avatar: null // Avatar should be fetched by client if needed or included in NATS
        },
        chatId: acceptData.chatId || '',
        createdAt: event.timestamp || new Date().toISOString()
      };

      io.to(`user:${senderId}`).emit('friend:request:accepted', socketPayload);
      io.to(`user:${acceptData.receiverId}`).emit('friend:request:accepted', socketPayload);
    }
  })();

  // Friend Request Rejected
  const friendRequestRejectedSub = natsConnection.subscribe(EventSubjects.FRIEND_REQUEST_REJECTED);
  (async () => {
    for await (const msg of friendRequestRejectedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { senderId, receiverId, requestId } = event.payload;
      console.log(`[WS] Friend request ${requestId} rejected by ${receiverId}`);
      io.to(`user:${senderId}`).emit('friend:request:rejected', { requestId, receiverId });
    }
  })();

  // Friend Request Cancelled
  const friendRequestCancelledSub = natsConnection.subscribe(EventSubjects.FRIEND_REQUEST_CANCELLED);
  (async () => {
    for await (const msg of friendRequestCancelledSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { senderId, receiverId, requestId } = event.payload;
      console.log(`[WS] Friend request ${requestId} cancelled by ${senderId}`);
      io.to(`user:${receiverId}`).emit('friend:request:cancelled', { requestId, senderId });
    }
  })();

  // Unfriended
  const friendUnfriendedSub = natsConnection.subscribe(EventSubjects.FRIEND_UNFRIENDED);
  (async () => {
    for await (const msg of friendUnfriendedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, friendId } = event.payload;
      console.log(`[WS] ${userId} unfriended ${friendId}`);
      io.to(`user:${userId}`).emit('friend:unfriended', { friendId });
      io.to(`user:${friendId}`).emit('friend:unfriended', { friendId: userId });
    }
  })();

  // User Blocked
  const friendUserBlockedSub = natsConnection.subscribe(EventSubjects.FRIEND_USER_BLOCKED);
  (async () => {
    for await (const msg of friendUserBlockedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { blockerId, blockedId } = event.payload;
      console.log(`[WS] ${blockerId} blocked ${blockedId}`);
      io.to(`user:${blockerId}`).emit('friend:blocked', { blockedId });
      io.to(`user:${blockedId}`).emit('friend:blocked', { blockerId });
    }
  })();

  // User Unblocked
  const friendUserUnblockedSub = natsConnection.subscribe(EventSubjects.FRIEND_USER_UNBLOCKED);
  (async () => {
    for await (const msg of friendUserUnblockedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { blockerId, blockedId } = event.payload;
      console.log(`[WS] ${blockerId} unblocked ${blockedId}`);
      io.to(`user:${blockerId}`).emit('friend:unblocked', { blockedId });
      io.to(`user:${blockedId}`).emit('friend:unblocked', { blockerId });
    }
  })();

  console.log('[WS Gateway] Subscribed to NATS events (including all friend actions)');
}

// ============= PUBLISH EVENTS =============

function publishEvent(subject: string, payload: any) {
  if (!natsConnection) return;
  natsConnection.publish(
    subject,
    jsonCodec.encode({
      subject,
      payload,
      timestamp: new Date().toISOString(),
    })
  );
}

// ============= SOCKET.IO MIDDLEWARE =============

io.use(async (socket: AuthenticatedSocket, next) => {
  try {
    let token =
      socket.handshake.auth.token ||
      socket.handshake.headers.authorization?.split(' ')[1];

    if (!token && socket.request.headers.cookie) {
      const match = socket.request.headers.cookie.match(/(?:^|;\s*)accessToken=([^;]*)/);
      if (match) {
        token = match[1];
      }
    }

    if (!token) {
      return next(new Error('Authentication required'));
    }

    const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string; id?: string; name?: string };
    socket.userId = decoded.sub || decoded.id || '';
    socket.userName = decoded.name || 'User';
    next();
  } catch (error) {
    next(new Error('Invalid token'));
  }
});

// ============= CONNECTION HANDLER =============

io.on('connection', async (socket: AuthenticatedSocket) => {
  const userId = socket.userId!;
  const userName = socket.userName!;

  console.log(`[WS] User connected: ${userName} (${userId}) - Socket: ${socket.id}`);

  // Khắc phục F5: Nếu user vừa F5, hủy timeout offline
  if (disconnectTimeouts.has(userId)) {
    clearTimeout(disconnectTimeouts.get(userId)!);
    disconnectTimeouts.delete(userId);
    console.log(`[WS] Khôi phục session nhanh cho F5: ${userName} (${userId})`);
  }

  // Add to online users
  const isNewLogin = !onlineUsers.has(userId);
  if (isNewLogin) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId)!.add(socket.id);

  // Join personal room
  socket.join(`user:${userId}`);

  // Notify others only if truly new login
  if (isNewLogin) {
    publishEvent(EventSubjects.USER_ONLINE, { userId, userName });
  }

  // Send online users list to new connection
  socket.emit('users:online', { userIds: Array.from(onlineUsers.keys()) });

  // ============= CHAT EVENT HANDLERS =============

  socket.on('chat:join', (data) => {
    const { chatId } = data;
    socket.join(`chat:${chatId}`);
    console.log(`[WS] ${userName} joined chat:${chatId}`);
  });

  socket.on('chat:leave', (data) => {
    const { chatId } = data;
    socket.leave(`chat:${chatId}`);
  });

  // Thread rooms
  socket.on('thread:join', (data) => {
    const { messageId } = data;
    socket.join(`thread:${messageId}`);
    console.log(`[WS] ${userName} joined thread:${messageId}`);
  });

  socket.on('thread:leave', (data) => {
    const { messageId } = data;
    socket.leave(`thread:${messageId}`);
  });

  // Message Send via Socket → forward to chat-service via HTTP
  socket.on('message:send', async (data) => {
    const { chatId, content, type = 'text', replyToId, tempId, fileName, fileSize, fileType } = data;

    if (!chatId || (!content && type === 'text')) {
      socket.emit('error', { message: 'chatId and content are required' });
      return;
    }

    try {
      // UNIFIED: Now points to messaging-service instead of chat-service
      const messagingServiceUrl = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3020';

      // Create HMAC signature
      const signature = createInternalSignature(INTERNAL_SERVICE_SECRET, {
        userId,
        role: 'USER',
      });

      const response = await fetch(`${messagingServiceUrl}/messages/${chatId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
          'x-user-name': userName,
          'x-internal-signature': signature,
        },
        body: JSON.stringify({ content, type, replyToId, fileName, fileSize, fileType }),
      });

      if (!response.ok) {
        const errorData: any = await response.json().catch(() => ({ message: 'Failed to send message' }));
        socket.emit('error', { message: errorData?.message || 'Failed to send message' });
      }
    } catch (error: any) {
      console.error(`[WS] Error sending message for ${userName}:`, error.message);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Typing
  socket.on('typing:start', (data) => {
    const { chatId } = data;
    socket.to(`chat:${chatId}`).emit('typing:start', { chatId, userId, userName });
    publishEvent(EventSubjects.TYPING_START, { chatId, userId, userName });
  });

  socket.on('typing:stop', (data) => {
    const { chatId } = data;
    socket.to(`chat:${chatId}`).emit('typing:stop', { chatId, userId });
    publishEvent(EventSubjects.TYPING_STOP, { chatId, userId });
  });

  // Mark message as read (Scalable Flow)
  socket.on('message:mark_as_read', (data) => {
    const { chatId, messageId } = data;
    if (!chatId) return;

    // Publish to NATS for chat-service to persist
    publishEvent('message.mark_as_read', {
      chatId,
      userId,
      messageId: messageId || undefined
    });

    console.log(`[WS] ${userName} marked ${chatId} as read (Async)`);
  });

  // React to message
  socket.on('message:react', async (data) => {
    const { messageId, chatId, emoji } = data;
    io.to(`chat:${chatId}`).emit('message:reacted', {
      messageId, chatId, userId, userName, emoji, action: 'added',
    });
  });

  // Pin message (Handled via NATS from messaging-service)

  // =============================================
  // ============= CALL SIGNALING ===============
  // =============================================

  // ─── Phase 1: CALL REQUEST (Caller initiates) ───
  socket.on('call:request', (data) => {
    const { chatId, targetUserId, isVideo = true, callType = 'private' } = data;

    console.log(`[Call] ${userName} requesting call to ${targetUserId || 'group'} in chat ${chatId}`);

    // Check if caller is already in a call
    if (userInCall.has(userId)) {
      socket.emit('call:error', { reason: 'already_in_call', message: 'Bạn đang trong cuộc gọi khác.' });
      return;
    }

    // For private calls: check if target user is online
    if (callType === 'private' && targetUserId) {
      if (!onlineUsers.has(targetUserId)) {
        socket.emit('call:error', { reason: 'callee_offline', message: 'Người nhận hiện không trực tuyến.' });
        return;
      }

      // Check if target user is already in a call (busy)
      if (userInCall.has(targetUserId)) {
        socket.emit('call:busy', { targetUserId, message: 'Người nhận đang trong cuộc gọi khác.' });
        return;
      }
    }

    // Generate unique room name
    const roomName = generateRoomName(chatId);

    // Lock: Register the call
    activeCalls.set(roomName, {
      callerId: userId,
      callerName: userName,
      calleeId: callType === 'private' ? targetUserId : undefined,
      chatId,
      participants: new Set([userId]),
      isVideo,
      callType,
      status: 'ringing',
      createdAt: new Date(),
    });

    // Mark caller as in-call
    userInCall.set(userId, roomName);

    if (callType === 'private' && targetUserId) {
      // Send incoming call to specific callee via personal room
      io.to(`user:${targetUserId}`).emit('call:incoming', {
        roomName,
        chatId,
        callerId: userId,
        callerName: userName,
        isVideo,
        callType,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Group: broadcast to ALL online members of the chat via their PERSONAL rooms
      // Optimized via gRPC
      messagingGrpcClient.getParticipantIds(chatId)
        .then(participantIds => {
          participantIds.forEach(memberId => {
            if (memberId !== userId) {
              io.to(`user:${memberId}`).emit('call:incoming', {
                roomName,
                chatId,
                callerId: userId,
                callerName: userName,
                isVideo,
                callType,
                timestamp: new Date().toISOString(),
              });
            }
          });
        })
        .catch(err => {
          console.error(`[Call] gRPC Failed to fetch participants for group call fan-out:`, err);
        });
    }
    
    // Broadcast to chat room that an active call exists (for UI join button)
    io.to(`chat:${chatId}`).emit('chat:call_status', {
      chatId,
      roomName,
      isActive: true,
      isVideo,
      callerId: userId,
      callerName: userName,
      callType,
    });

    // Confirm to caller that the call is ringing
    socket.emit('call:ringing', { roomName, chatId });

    // Auto-cancel if no answer after 30s
    const ringingTimeout = setTimeout(() => {
      const call = activeCalls.get(roomName);
      if (call && call.status === 'ringing') {
        console.log(`[Call] Ringing timeout for room ${roomName}`);
        io.to(`user:${userId}`).emit('call:ended', {
          roomName,
          reason: 'no_answer',
          message: 'Không có ai trả lời.',
        });
        if (callType === 'private' && targetUserId) {
          io.to(`user:${targetUserId}`).emit('call:ended', { roomName, reason: 'missed' });
        } else {
          socket.to(`chat:${chatId}`).emit('call:ended', { roomName, reason: 'missed' });
        }
        // Save missed call event to chat history
        saveCallEventMessage(chatId, userId, 'call_missed', {
          isVideo,
          callerName: userName,
        });
        cleanupCall(roomName);
      }
    }, RINGING_TIMEOUT_MS);

    ringingTimeouts.set(roomName, ringingTimeout);
  });

  // ─── Phase 2: CALL ACCEPTED (Callee accepts) ───
  socket.on('call:accepted', async (data) => {
    const { roomName } = data;
    const call = activeCalls.get(roomName);

    if (!call) {
      socket.emit('call:error', { reason: 'call_not_found', message: 'Cuộc gọi không tồn tại hoặc đã kết thúc.' });
      return;
    }

    // For private calls, only allow one accept
    if (call.callType === 'private' && call.status !== 'ringing') {
      socket.emit('call:error', { reason: 'call_already_answered', message: 'Cuộc gọi đã được trả lời.' });
      return;
    }

    // For group calls, allow join if call is ringing or already active
    if (call.callType === 'group' && call.status === 'ended') {
      socket.emit('call:error', { reason: 'call_ended', message: 'Cuộc gọi đã kết thúc.' });
      return;
    }

    console.log(`[Call] ${userName} accepted call in room ${roomName}`);

    // Clear ringing timeout (only on first accept)
    const timeout = ringingTimeouts.get(roomName);
    if (timeout) {
      clearTimeout(timeout);
      ringingTimeouts.delete(roomName);
    }

    // Update call status
    const isFirstAccept = call.status === 'ringing';
    call.status = 'active';
    if (call.callType === 'private') {
      call.calleeId = userId;
    }

    if (isFirstAccept) {
      saveCallEventMessage(call.chatId, call.callerId, 'call_started', {
        isVideo: call.isVideo,
        callerName: call.callerName,
      });
    }

    // Add participant to set
    call.participants.add(userId);

    // Mark participant as in-call
    userInCall.set(userId, roomName);

    try {
      // Generate token for the accepting/joining user
      const joinerToken = await generateLiveKitToken(userId, userName, roomName);

      if (call.callType === 'private') {
        // Private: First accept → generate tokens for BOTH parties
        const callerToken = await generateLiveKitToken(call.callerId, call.callerName, roomName);

        io.to(`user:${call.callerId}`).emit('call:start_info', {
          roomName,
          token: callerToken,
          serverUrl: LIVEKIT_URL,
          isVideo: call.isVideo,
          chatId: call.chatId,
        });

        socket.emit('call:start_info', {
          roomName,
          token: joinerToken,
          serverUrl: LIVEKIT_URL,
          isVideo: call.isVideo,
          chatId: call.chatId,
        });
      } else {
        // Group: send token to new joiner
        socket.emit('call:start_info', {
          roomName,
          token: joinerToken,
          serverUrl: LIVEKIT_URL,
          isVideo: call.isVideo,
          chatId: call.chatId,
        });

        // On first accept, also send caller their token
        if (call.participants.size === 2) {
          const callerToken = await generateLiveKitToken(call.callerId, call.callerName, roomName);
          io.to(`user:${call.callerId}`).emit('call:start_info', {
            roomName,
            token: callerToken,
            serverUrl: LIVEKIT_URL,
            isVideo: call.isVideo,
            chatId: call.chatId,
          });
        }

        // Member joined group call: save event
        saveCallEventMessage(call.chatId, userId, 'call_participant_joined', {
          isVideo: call.isVideo,
          callerName: userName,
        });

        // Notify others a new participant joined
        socket.to(`chat:${call.chatId}`).emit('call:participant_joined', {
          roomName,
          participantId: userId,
          participantName: userName,
          participantCount: call.participants.size,
        });
      }

      console.log(`[Call] ✅ Token issued for ${userName} in room ${roomName}. Participants: ${call.participants.size}`);
    } catch (error: any) {
      console.error(`[Call] ❌ Failed to generate tokens:`, error.message);
      socket.emit('call:error', { reason: 'token_error', message: 'Không thể tạo token cho cuộc gọi.' });
      if (call.callType === 'private') {
        io.to(`user:${call.callerId}`).emit('call:error', { reason: 'token_error', message: 'Lỗi kết nối cuộc gọi.' });
        cleanupCall(roomName);
      } else {
        // Group: just remove this participant, don't kill the room
        removeParticipant(roomName, userId);
      }
    }
  });

  // ─── Phase 2b: CALL DECLINED (Callee rejects) ───
  socket.on('call:declined', (data) => {
    const { roomName } = data;
    const call = activeCalls.get(roomName);

    if (!call) return;

    console.log(`[Call] ${userName} declined call in room ${roomName}`);

    io.to(`user:${call.callerId}`).emit('call:declined', {
      roomName,
      declinedById: userId,
      declinedByName: userName,
    });

    // Save declined event to chat history
    saveCallEventMessage(call.chatId, call.callerId, 'call_declined', {
      isVideo: call.isVideo,
      callerName: call.callerName,
    });

    cleanupCall(roomName);
  });

  // ─── Phase 4: CALL ENDED / LEAVE ───
  socket.on('call:ended', (data) => {
    const { roomName, forceAll = false } = data;
    const call = activeCalls.get(roomName);

    if (!call) return;

    const duration = Math.round((Date.now() - call.createdAt.getTime()) / 1000);

    // ── FORCE END FOR ALL (Group Call - Initiator only) ──
    if (call.callType === 'group' && forceAll && call.callerId === userId) {
      console.log(`[Call] ${userName} (Initiator) ENDED GROUP CALL FOR ALL in room ${roomName}`);
      
      // Notify all participants except the one who ended it (they handle it locally)
      // Actually, we can notify EVERYONE in the chat room associated with this room
      io.to(`chat:${call.chatId}`).emit('call:ended', {
        roomName,
        reason: 'ended_by_initiator',
        endedBy: userId,
        endedByName: userName,
        duration,
      });

      // Save call event message
      saveCallEventMessage(call.chatId, call.callerId, 'call_ended', {
        isVideo: call.isVideo,
        duration,
        callerName: call.callerName,
      });

      cleanupCall(roomName);
      return;
    }

    // ── PRIVATE CALL: End for both parties immediately ──
    if (call.callType === 'private') {
      console.log(`[Call] ${userName} ended PRIVATE call in room ${roomName}`);
      const otherUserId = userId === call.callerId ? call.calleeId : call.callerId;
      if (otherUserId) {
        io.to(`user:${otherUserId}`).emit('call:ended', {
          roomName,
          endedBy: userId,
          endedByName: userName,
          duration,
        });
      }
      // Save call event message to chat history
      saveCallEventMessage(call.chatId, call.callerId, 'call_ended', {
        isVideo: call.isVideo,
        duration,
        callerName: call.callerName,
      });
      cleanupCall(roomName);
      return;
    }

    // ── GROUP CALL: User leaves, room stays alive ──
    console.log(`[Call] ${userName} left GROUP call in room ${roomName}`);

    // Notify others that this user left
    socket.to(`chat:${call.chatId}`).emit('call:participant_left', {
      roomName,
      participantId: userId,
      participantName: userName,
    });

    // Remove this participant from the tracking
    const roomEmpty = removeParticipant(roomName, userId);

    // Save participant left event to history
    saveCallEventMessage(call.chatId, userId, 'call_participant_left', {
      isVideo: call.isVideo,
      callerName: userName,
    });

    if (roomEmpty) {
      console.log(`[Call] Group call room ${roomName} is empty. Cleaning up.`);
      // Notify chat that the group call has ended
      io.to(`chat:${call.chatId}`).emit('call:ended', {
        roomName,
        reason: 'room_empty',
        duration,
      });
      // Save call event message to chat history
      saveCallEventMessage(call.chatId, call.callerId, 'call_ended', {
        isVideo: call.isVideo,
        duration,
        callerName: call.callerName,
      });
      cleanupCall(roomName);
    }
  });

  // ─── CANCEL: Caller cancels before callee answers ───
  socket.on('call:cancel', (data) => {
    const { roomName } = data;
    const call = activeCalls.get(roomName);

    if (!call || call.callerId !== userId) return;

    console.log(`[Call] ${userName} cancelled call in room ${roomName}`);

    if (call.callType === 'private' && call.calleeId) {
      io.to(`user:${call.calleeId}`).emit('call:ended', { roomName, reason: 'cancelled' });
    } else {
      socket.to(`chat:${call.chatId}`).emit('call:ended', { roomName, reason: 'cancelled' });
    }

    // Save cancelled event to chat history
    saveCallEventMessage(call.chatId, call.callerId, 'call_cancelled', {
      isVideo: call.isVideo,
      callerName: call.callerName,
    });

    cleanupCall(roomName);
  });

  // ─── CHECK ACTIVE CALL ───
  socket.on('call:check', (data) => {
    const { chatId } = data;
    // Find any active call in this chat
    const activeEntry = Array.from(activeCalls.entries()).find(([_, call]) => call.chatId === chatId);
    
    if (activeEntry) {
      const [roomName, call] = activeEntry;
      socket.emit('call:active_status', {
        chatId,
        roomName,
        isActive: true,
        isVideo: call.isVideo,
        callerId: call.callerId,
        callerName: call.callerName,
        callType: call.callType,
        participantCount: call.participants.size
      });
    } else {
      socket.emit('call:active_status', { chatId, isActive: false });
    }
  });

  // ============= DISCONNECT =============

  socket.on('disconnect', async () => {
    console.log(`[WS] User disconnected: ${userName} (${userId})`);

    // Cleanup active call on disconnect
    const roomName = userInCall.get(userId);
    if (roomName) {
      const call = activeCalls.get(roomName);
      if (call) {
        console.log(`[Call] ${userName} disconnected during active call ${roomName}`);

        if (call.callType === 'private') {
          // Private: end for both
          const otherUserId = userId === call.callerId ? call.calleeId : call.callerId;
          if (otherUserId) {
            io.to(`user:${otherUserId}`).emit('call:ended', {
              roomName, endedBy: userId, reason: 'disconnected',
            });
          }
          cleanupCall(roomName);
        } else {
          // Group: just remove participant, keep room alive if others remain
          socket.to(`chat:${call.chatId}`).emit('call:participant_left', {
            roomName,
            participantId: userId,
            participantName: userName,
          });
          const roomEmpty = removeParticipant(roomName, userId);
          if (roomEmpty) {
            io.to(`chat:${call.chatId}`).emit('call:ended', {
              roomName, reason: 'room_empty',
            });
            cleanupCall(roomName);
          }
        }
      }
    }

    // Remove from online users
    const userSockets = onlineUsers.get(userId);
    if (userSockets) {
      userSockets.delete(socket.id);

      // Khắc phục F5: Trì hoãn offline 5 giây
      if (userSockets.size === 0) {
        const timeoutId = setTimeout(() => {
          onlineUsers.delete(userId);
          const lastSeen = new Date().toISOString();
          publishEvent(EventSubjects.USER_OFFLINE, { userId, lastSeen });
          disconnectTimeouts.delete(userId);
          console.log(`[WS] Hoàn tất offline cho: ${userName} (${userId})`);
        }, 5000);

        disconnectTimeouts.set(userId, timeoutId);
      }
    }
  });
});

// ============= GRACEFUL SHUTDOWN =============

async function shutdown() {
  console.log('\n[WS Gateway] Shutting down...');

  io.close();

  if (natsConnection) {
    await natsConnection.drain();
  }

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ============= START SERVER =============

async function start() {
  await setupRedisAdapter();
  await setupNats();

  httpServer.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`🔌 WS Gateway running on port ${PORT}`);
    console.log(`📡 Socket.IO ready for connections`);
    console.log(`🔄 Redis adapter: ${REDIS_URL}`);
    console.log(`📨 NATS: ${NATS_URL}`);
    console.log(`📞 LiveKit: ${LIVEKIT_URL}`);
    console.log('='.repeat(50));
  });
}

start();

export { io };
