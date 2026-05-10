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
import { messagingGrpcClient } from './messagingClient.js';

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
  role?: string;
  orgId?: string;
}

// Map lưu trữ users đang online
const onlineUsers = new Map<string, Set<string>>();
// Khắc phục F5: Map lưu trữ timeout để trì hoãn việc đánh dấu offline
const disconnectTimeouts = new Map<string, NodeJS.Timeout>();

// NATS
let natsConnection: NatsConnection | null = null;
const jsonCodec = JSONCodec();
let activeSubscriptions: any[] = [];

const EventSubjects = {
  // ===== Message events =====
  MESSAGE_CREATED: 'message.created',
  MESSAGE_UPDATED: 'message.updated',
  MESSAGE_DELETED: 'message.deleted',
  MESSAGE_READ: 'message.read',
  MESSAGE_REACTION: 'message.reaction',
  MESSAGE_EDITED: 'message.edited',

  // Thread events
  THREAD_REPLY_CREATED: 'thread.reply.created',

  // Mention events
  USER_MENTIONED: 'user.mentioned',
  MENTION_BROADCAST: 'mention.broadcast',

  // File events
  CHAT_FILE_UPLOADED: 'file.chat.upload',

  // ===== Group events =====
  GROUP_CREATED: 'group.created',
  GROUP_UPDATED: 'group.updated',
  GROUP_DELETED: 'group.deleted',
  GROUP_MEMBER_ADDED: 'group.member.added',
  GROUP_MEMBER_REMOVED: 'group.member.removed',
  GROUP_MEMBER_ROLE_UPDATED: 'group.member.role.updated',

  // Workspace events
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_DELETED: 'workspace.deleted',
  WORKSPACE_MEMBER_ADDED: 'workspace.member.added',
  WORKSPACE_MEMBER_REMOVED: 'workspace.member.removed',
  WORKSPACE_INVITE_CREATED: 'workspace.invite.created',
  WORKSPACE_INVITE_ACCEPTED: 'workspace.invite.accepted',
  WORKSPACE_INVITE_REJECTED: 'workspace.invite.rejected',
  WORKSPACE_INVITE_CANCELLED: 'workspace.invite.cancelled',
  WORKSPACE_MEMBER_ROLE_UPDATED: 'workspace.member.role.updated',
  WORKSPACE_DISSOLVED: 'workspace.dissolved',
  WORKSPACE_RESTORED: 'workspace.restored',
  WORKSPACE_MEMBER_KICKED: 'workspace.member.kicked',
  WORKSPACE_MEMBER_LEFT: 'workspace.member.left',
  WORKSPACE_OWNER_TRANSFERRED: 'workspace.owner.transferred',

  // Channel events
  CHANNEL_CREATED: 'channel.created',
  CHANNEL_UPDATED: 'channel.updated',
  CHANNEL_DELETED: 'channel.deleted',
  CHANNEL_ARCHIVED: 'channel.archived',
  CHANNEL_MEMBER_ADDED: 'channel.member.added',
  CHANNEL_MEMBER_REMOVED: 'channel.member.removed',

  // Admin/Audit events
  AUDIT_LOG_CREATED: 'admin.audit_log.created',
  RBAC_UPDATED: 'rbac.updated',
  WORKSPACE_QUOTA_UPDATED: 'workspace.quota.updated',

  // Join Request events
  GROUP_JOIN_REQUEST_CREATED: 'group.join.request.created',
  GROUP_JOIN_REQUEST_UPDATED: 'group.join.request.updated',

  // Task events
  TASK_CREATED: 'task.created',
  TASK_UPDATED: 'task.updated',
  TASK_DELETED: 'task.deleted',
  TASK_DEADLINE_APPROACHING: 'task.deadline.approaching',

  // Friend events
  FRIEND_REQUEST_SENT: 'friend.request.sent',
  FRIEND_REQUEST_ACCEPTED: 'friend.request.accepted',
  FRIEND_REQUEST_REJECTED: 'friend.request.rejected',
  FRIEND_REQUEST_CANCELLED: 'friend.request.cancelled',
  FRIEND_UNFRIENDED: 'friend.unfriended',
  FRIEND_USER_BLOCKED: 'friend.user.blocked',
  FRIEND_USER_UNBLOCKED: 'friend.user.unblocked',

  // ===== System/Gateway specific events =====
  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',
  TYPING_START: 'typing.start',
  TYPING_STOP: 'typing.stop',
  USER_AVATAR_UPDATED: 'user.avatar.updated',
  NOTIFICATION_CREATED: 'notification.created',
  SYSTEM_BROADCAST: 'system.broadcast',
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
  messageType: 'call_ended' | 'call_missed' | 'call_declined' | 'call_cancelled' | 'call_started' | 'call_participant_joined' | 'call_participant_left',
  metadata: { isVideo: boolean; duration?: number; callerName?: string }
) {
  try {
    // UNIFIED: Now points to messaging-service instead of chat-service
    const messagingServiceUrl = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3020';
    const content = JSON.stringify(metadata);
    
    await fetch(`${messagingServiceUrl}/messages/${chatId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': callerId,
        'x-user-name': metadata.callerName || 'System',
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
    const pubClient = new Redis(REDIS_URL, { lazyConnect: true });
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));
    console.log('[WS Gateway] Redis adapter connected');
  } catch (error) {
    console.error('[WS Gateway] Redis adapter failed to connect:', error);
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
    
    // Catch-all subscriber for debugging
    const allEventsSub = natsConnection.subscribe('>');
    (async () => {
      for await (const msg of allEventsSub) {
        try {
          const decoded = jsonCodec.decode(msg.data) as any;
          console.log(`[NATS DEBUG] Received event on subject: ${msg.subject}`, decoded);
        } catch (e) {
          console.log(`[NATS DEBUG] Received raw message on subject: ${msg.subject}`);
        }
      }
    })();

    // Listen for reconnection to re-subscribe
    (async () => {
      if (!natsConnection) return;
      for await (const s of natsConnection.status()) {
        console.log(`[WS Gateway] NATS status change: ${s.type}`);
        if ((s.type as string) === 'reconnect' || (s.type as string) === 'connect') {
          console.log('[WS Gateway] NATS (re)connected, setting up subscriptions...');
          subscribeToNatsEvents();
        }
      }
    })();

    subscribeToNatsEvents();
  } catch (error) {
    console.warn('[WS Gateway] NATS not available', error);
  }
}

function subscribeToNatsEvents() {
  if (!natsConnection) return;

  // Clear existing subscriptions to avoid duplicates on reconnect
  for (const sub of activeSubscriptions) {
    try { sub.unsubscribe(); } catch (e) {}
  }
  activeSubscriptions = [];

  const addSub = (sub: any) => {
    activeSubscriptions.push(sub);
    return sub;
  };

  // Message Created -> Fan-out to each participant's personal room
  const msgCreatedSub = addSub(natsConnection.subscribe(EventSubjects.MESSAGE_CREATED));
  (async () => {
    for await (const msg of msgCreatedSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const { chatId, ...messageData } = event.payload;

        // UNIFIED: Now points to messaging-service instead of group-service
        const messagingServiceUrl = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3020';
        const response = await fetch(`${messagingServiceUrl}/chats/internal/${chatId}/participant-ids`, {
          headers: {
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
      }
    }
  })();


  // Message Read
  const msgReadSub = addSub(natsConnection.subscribe(EventSubjects.MESSAGE_READ));
  (async () => {
    for await (const msg of msgReadSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, userId, readAt, messageId } = event.payload;
      io.to(`chat:${chatId}`).emit('message:read', { chatId, userId, readAt, messageId });
    }
  })();

  // Message Reaction
  const msgReactSub = addSub(natsConnection.subscribe(EventSubjects.MESSAGE_REACTION));
  (async () => {
    for await (const msg of msgReactSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, ...reactionData } = event.payload;
      io.to(`chat:${chatId}`).emit('message:reacted', { chatId, ...reactionData });
    }
  })();

  // Message Deleted
  const msgDeletedSub = addSub(natsConnection.subscribe(EventSubjects.MESSAGE_DELETED));
  (async () => {
    for await (const msg of msgDeletedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, ...deleteData } = event.payload;
      io.to(`chat:${chatId}`).emit('message:recalled', { chatId, ...deleteData });
    }
  })();

  // Message Pinned
  const msgPinnedSub = addSub(natsConnection.subscribe('message.pinned'));
  (async () => {
    for await (const msg of msgPinnedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, messageId, pin, userId, userName } = event.payload;
      io.to(`chat:${chatId}`).emit('message:pinned', { chatId, messageId, pin, userId, userName });
    }
  })();

  // Thread Reply Created
  const threadReplySub = addSub(natsConnection.subscribe('thread.reply.created'));
  (async () => {
    for await (const msg of threadReplySub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, parentId, ...replyData } = event.payload;
      io.to(`chat:${chatId}`).emit('thread:reply', { chatId, parentId, reply: replyData });
      io.to(`thread:${parentId}`).emit('thread:reply', { parentId, reply: replyData });
    }
  })();



  // Mention Broadcast (@here, @channel)
  const mentionBroadcastSub = addSub(natsConnection.subscribe('mention.broadcast'));
  (async () => {
    for await (const msg of mentionBroadcastSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, messageId, mentionedBy, types } = event.payload;
      io.to(`chat:${chatId}`).emit('mention:broadcast', { chatId, messageId, mentionedBy, types });
    }
  })();

  // Message Edited
  const msgEditedSub = addSub(natsConnection.subscribe('message.edited'));
  (async () => {
    for await (const msg of msgEditedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, messageId, content, editedAt } = event.payload;
      io.to(`chat:${chatId}`).emit('message:edited', { chatId, messageId, content, editedAt });
    }
  })();

  // User Online
  const userOnlineSub = addSub(natsConnection.subscribe(EventSubjects.USER_ONLINE));
  (async () => {
    for await (const msg of userOnlineSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId } = event.payload;
      io.emit('user:online', { userId });
    }
  })();

  // User Offline
  const userOfflineSub = addSub(natsConnection.subscribe(EventSubjects.USER_OFFLINE));
  (async () => {
    for await (const msg of userOfflineSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, lastSeen } = event.payload;
      io.emit('user:offline', { userId, lastSeen });
    }
  })();

  // User Avatar Updated
  const userAvatarSub = addSub(natsConnection.subscribe(EventSubjects.USER_AVATAR_UPDATED));
  (async () => {
    for await (const msg of userAvatarSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, avatar } = event.payload;
      console.log(`[WS] Broadcasting avatar update for user: ${userId}`);
      io.emit('user:avatar:updated', { userId, avatar });
    }
  })();
  

  // Friend Request Sent
  const friendRequestSentSub = addSub(natsConnection.subscribe(EventSubjects.FRIEND_REQUEST_SENT));
  (async () => {
    for await (const msg of friendRequestSentSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const { requestId, senderId, receiverId, senderName, senderAvatar, receiverName } = event.payload;
        console.log(`[WS] Friend request ${requestId} from ${senderId} to ${receiverId} (${receiverName})`);
        
        const socketPayload = {
          id: requestId,
          sender: {
            id: senderId,
            name: senderName,
            avatar: senderAvatar
          },
          createdAt: event.timestamp || new Date().toISOString()
        };

        // Notify receiver
        io.to(`user:${receiverId}`).emit('friend:request:received', socketPayload);
        
        // Notify sender (for other tabs/sync)
        io.to(`user:${senderId}`).emit('friend:request:sent', { requestId, receiverId, receiverName });
      } catch (err) {
        console.error('[WS] Error processing friend:request:sent:', err);
      }
    }
  })();

  // Friend Request Accepted
  const friendRequestAcceptedSub = addSub(natsConnection.subscribe(EventSubjects.FRIEND_REQUEST_ACCEPTED));
  (async () => {
    for await (const msg of friendRequestAcceptedSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const { senderId, receiverId, receiverName, senderName, receiverAvatar, senderAvatar, chatId } = event.payload;
        console.log(`[WS] Friend request accepted by ${receiverName} (${receiverId}), notifying sender ${senderId}`);
        
        // Notify Sender (Person A) - they get info about Person B
        io.to(`user:${senderId}`).emit('friend:request:accepted', {
          friendId: receiverId,
          user: {
            id: receiverId,
            name: receiverName,
            avatar: receiverAvatar
          },
          chatId: chatId || '',
          createdAt: event.timestamp || new Date().toISOString()
        });

        // Notify Receiver (Person B) - they get info about Person A (sync other tabs)
        io.to(`user:${receiverId}`).emit('friend:request:accepted', {
          friendId: senderId,
          user: {
            id: senderId,
            name: senderName || 'Người gửi',
            avatar: senderAvatar
          },
          chatId: chatId || '',
          createdAt: event.timestamp || new Date().toISOString()
        });
      } catch (err) {
        console.error('[WS] Error processing friend:request:accepted:', err);
      }
    }
  })();

  // Friend Request Rejected
  const friendRequestRejectedSub = addSub(natsConnection.subscribe(EventSubjects.FRIEND_REQUEST_REJECTED));
  (async () => {
    for await (const msg of friendRequestRejectedSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const { senderId, receiverId, requestId } = event.payload;
        console.log(`[WS] Friend request ${requestId} rejected by ${receiverId}`);
        
        // Notify both parties to sync all tabs
        io.to(`user:${senderId}`).emit('friend:request:rejected', { requestId, receiverId });
        io.to(`user:${receiverId}`).emit('friend:request:rejected', { requestId, senderId });
      } catch (err) {
        console.error('[WS] Error processing friend:request:rejected:', err);
      }
    }
  })();

  // Friend Request Cancelled
  const friendRequestCancelledSub = addSub(natsConnection.subscribe(EventSubjects.FRIEND_REQUEST_CANCELLED));
  (async () => {
    for await (const msg of friendRequestCancelledSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const { senderId, receiverId, requestId } = event.payload;
        console.log(`[WS] Friend request ${requestId} cancelled by ${senderId}`);
        
        // Notify both parties to sync all tabs
        io.to(`user:${receiverId}`).emit('friend:request:cancelled', { requestId, senderId });
        io.to(`user:${senderId}`).emit('friend:request:cancelled', { requestId, receiverId });
      } catch (err) {
        console.error('[WS] Error processing friend:request:cancelled:', err);
      }
    }
  })();

  // Friend Unfriended
  const friendUnfriendedSub = addSub(natsConnection.subscribe(EventSubjects.FRIEND_UNFRIENDED));
  (async () => {
    for await (const msg of friendUnfriendedSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const { userId, friendId } = event.payload;
        console.log(`[WS] User ${userId} unfriended ${friendId}`);
        
        io.to(`user:${userId}`).emit('friend:unfriended', { friendId });
        io.to(`user:${friendId}`).emit('friend:unfriended', { friendId: userId });
      } catch (err) {
        console.error('[WS] Error processing friend:unfriended:', err);
      }
    }
  })();

  // Friend Blocked
  const friendBlockedSub = addSub(natsConnection.subscribe(EventSubjects.FRIEND_USER_BLOCKED));
  (async () => {
    for await (const msg of friendBlockedSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const { blockerId, blockedId } = event.payload;
        console.log(`[WS] User ${blockerId} blocked ${blockedId}`);
        
        io.to(`user:${blockerId}`).emit('friend:blocked', { blockedId });
        io.to(`user:${blockedId}`).emit('friend:blocked', { blockerId });
      } catch (err) {
        console.error('[WS] Error processing friend:blocked:', err);
      }
    }
  })();

  // Friend Unblocked
  const friendUnblockedSub = addSub(natsConnection.subscribe(EventSubjects.FRIEND_USER_UNBLOCKED));
  (async () => {
    for await (const msg of friendUnblockedSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const { blockerId, blockedId } = event.payload;
        console.log(`[WS] User ${blockerId} unblocked ${blockedId}`);
        
        io.to(`user:${blockerId}`).emit('friend:unblocked', { blockedId });
        io.to(`user:${blockedId}`).emit('friend:unblocked', { blockerId });
      } catch (err) {
        console.error('[WS] Error processing friend:unblocked:', err);
      }
    }
  })();
  
  // Workspace Invite Created
  const workspaceInviteSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_INVITE_CREATED));
  (async () => {
    for await (const msg of workspaceInviteSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { inviteeId, workspaceName, inviterId, role, token } = event.payload;
      
      if (inviteeId) {
        console.log(`[WS] Notifying user ${inviteeId} about new workspace invite for ${workspaceName}`);
        io.to(`user:${inviteeId}`).emit('workspace:invite:new', {
          workspaceName,
          role,
          token,
          inviterId,
          timestamp: event.timestamp || new Date().toISOString()
        });
      }
    }
  })();

  // Workspace Dissolved
  const workspaceDissolvedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_DISSOLVED));
  (async () => {
    for await (const msg of workspaceDissolvedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, memberIds, dissolvedBy } = event.payload;
      
      console.log(`[WS] Workspace ${workspaceId} dissolved. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:dissolved', { workspaceId, dissolvedBy });
        }
      }
    }
  })();

  // Workspace Restored
  const workspaceRestoredSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_RESTORED));
  (async () => {
    for await (const msg of workspaceRestoredSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, memberIds, restoredBy } = event.payload;
      
      console.log(`[WS] Workspace ${workspaceId} restored. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:restored', { workspaceId, restoredBy });
        }
      }
    }
  })();

  // Workspace Member Left/Kicked
  const workspaceMemberEvents = [
    EventSubjects.WORKSPACE_MEMBER_LEFT,
    EventSubjects.WORKSPACE_MEMBER_KICKED
  ];

  for (const subject of workspaceMemberEvents) {
    const sub = addSub(natsConnection.subscribe(subject));
    (async () => {
      for await (const msg of sub) {
        const event = jsonCodec.decode(msg.data) as any;
        const { workspaceId, userId, memberIds, reason, kickedBy } = event.payload;
        
        console.log(`[WS] User ${userId} left/kicked from workspace ${workspaceId}. Reason: ${reason}`);
        
        // Notify the user who left
        io.to(`user:${userId}`).emit('workspace:member:left', { workspaceId, userId, reason, kickedBy });
        
        // Notify remaining members
        if (Array.isArray(memberIds)) {
          for (const uid of memberIds) {
            if (uid !== userId) {
              io.to(`user:${uid}`).emit('workspace:member:updated', { workspaceId, userId, action: 'removed', reason });
            }
          }
        }
      }
    })();
  }

  // Workspace Created
  const workspaceCreatedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_CREATED));
  (async () => {
    for await (const msg of workspaceCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, workspace } = event.payload;
      console.log(`[WS] Workspace ${workspace?.id} created by user ${userId}`);
      io.to(`user:${userId}`).emit('workspace:created', { workspace });
    }
  })();

  // Workspace Updated
  const workspaceUpdatedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_UPDATED));
  (async () => {
    for await (const msg of workspaceUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { id, memberIds, ...updates } = event.payload;
      console.log(`[WS] Workspace ${id} updated. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:updated', { workspaceId: id, ...updates });
        }
      }
    }
  })();

  // Workspace Member Added
  const workspaceMemberAddedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_MEMBER_ADDED));
  (async () => {
    for await (const msg of workspaceMemberAddedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, userId, memberIds } = event.payload;
      console.log(`[WS] User ${userId} added to workspace ${workspaceId}`);
      
      // Notify all current members if list provided
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:member:updated', { workspaceId, userId, action: 'added' });
        }
      } else {
        // Fallback: Notify the new member at least
        io.to(`user:${userId}`).emit('workspace:member:updated', { workspaceId, userId, action: 'added' });
      }
    }
  })();

  // Workspace Member Removed
  const workspaceMemberRemovedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_MEMBER_REMOVED));
  (async () => {
    for await (const msg of workspaceMemberRemovedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, userId, memberIds } = event.payload;
      console.log(`[WS] User ${userId} removed from workspace ${workspaceId}`);
      io.to(`user:${userId}`).emit('workspace:member:left', { workspaceId, userId, reason: 'REMOVED' });
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          if (uid !== userId) {
            io.to(`user:${uid}`).emit('workspace:member:updated', { workspaceId, userId, action: 'removed' });
          }
        }
      }
    }
  })();

  // RBAC Updated -> Instant permission refresh
  const rbacUpdatedSub = addSub(natsConnection.subscribe(EventSubjects.RBAC_UPDATED));
  (async () => {
    for await (const msg of rbacUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, role, scope, scopeId } = event.payload;
      console.log(`[WS] RBAC updated for user ${userId}: ${role} (${scope}:${scopeId})`);
      io.to(`user:${userId}`).emit('rbac:updated', { role, scope, scopeId });
    }
  })();

  // Workspace Quota Updated
  const quotaUpdatedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_QUOTA_UPDATED));
  (async () => {
    for await (const msg of quotaUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { orgId, used, limit } = event.payload;
      console.log(`[WS] Quota updated for org ${orgId}: ${used}/${limit}`);
      io.to(`org:${orgId}`).emit('workspace:quota:updated', { used, limit });
    }
  })();

  // Audit Log Created -> Live feed for admins
  const auditLogSub = addSub(natsConnection.subscribe(EventSubjects.AUDIT_LOG_CREATED));
  (async () => {
    for await (const msg of auditLogSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, action, resource, data } = event.payload;
      
      // Emit to org room if data contains orgId
      const orgId = data?.orgId;
      if (orgId) {
        console.log(`[WS] Live Audit Log for org ${orgId}: ${action} by ${userId}`);
        io.to(`org:${orgId}`).emit('admin:audit:new', { userId, action, resource, data, createdAt: event.timestamp });
      }
      
      // Also emit to system admin room
      io.to('role:SUPER_ADMIN').to('role:ADMIN').emit('admin:audit:new', { userId, action, resource, data, createdAt: event.timestamp });
    }
  })();

  // Workspace Member Role Updated
  const workspaceMemberRoleSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_MEMBER_ROLE_UPDATED));
  (async () => {
    for await (const msg of workspaceMemberRoleSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, userId, role, memberIds } = event.payload;
      
      console.log(`[WS] Role updated for user ${userId} in workspace ${workspaceId} to ${role}`);
      
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:member:updated', { workspaceId, userId, action: 'role_updated', role });
        }
      }
    }
  })();

  // Workspace Owner Transferred
  const workspaceOwnerTransferredSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_OWNER_TRANSFERRED));
  (async () => {
    for await (const msg of workspaceOwnerTransferredSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, oldOwnerId, newOwnerId, memberIds } = event.payload;
      
      console.log(`[WS] Ownership transferred for workspace ${workspaceId} from ${oldOwnerId} to ${newOwnerId}`);
      
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:owner:transferred', { workspaceId, oldOwnerId, newOwnerId });
        }
      }
    }
  })();

  // Workspace Invite Accepted
  const workspaceInviteAcceptedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_INVITE_ACCEPTED));
  (async () => {
    for await (const msg of workspaceInviteAcceptedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, userId, inviterId, memberIds } = event.payload;
      
      console.log(`[WS] User ${userId} accepted invite for workspace ${workspaceId}`);
      
      // Notify the inviter specifically
      if (inviterId) {
        io.to(`user:${inviterId}`).emit('workspace:invite:accepted', { workspaceId, userId });
      }

      // Notify all members to refresh their list
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:member:updated', { workspaceId, userId, action: 'joined' });
        }
      }
    }
  })();

  // Workspace Invite Rejected
  const workspaceInviteRejectedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_INVITE_REJECTED));
  (async () => {
    for await (const msg of workspaceInviteRejectedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, email, inviterId } = event.payload;
      
      console.log(`[WS] Invite to ${email} for workspace ${workspaceId} was rejected.`);
      
      // Notify the inviter specifically
      if (inviterId) {
        io.to(`user:${inviterId}`).emit('workspace:invite:rejected', { workspaceId, email });
      }
    }
  })();

  // Workspace Invite Cancelled
  const workspaceInviteCancelledSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_INVITE_CANCELLED));
  (async () => {
    for await (const msg of workspaceInviteCancelledSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, memberIds } = event.payload;
      
      console.log(`[WS] Invite cancelled for workspace ${workspaceId}. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:invite:cancelled', { workspaceId });
        }
      }
    }
  })();

  // Workspace Deleted (Hard delete)
  const workspaceDeletedSub = addSub(natsConnection.subscribe(EventSubjects.WORKSPACE_DELETED));
  (async () => {
    for await (const msg of workspaceDeletedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { id, workspaceId, memberIds } = event.payload;
      const finalId = workspaceId || id;
      
      console.log(`[WS] Workspace ${finalId} deleted. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('workspace:deleted', { workspaceId: finalId });
        }
      }
    }
  })();

  // Group Created
  const groupCreatedSub = addSub(natsConnection.subscribe(EventSubjects.GROUP_CREATED));
  (async () => {
    for await (const msg of groupCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { id, memberIds } = event.payload;
      console.log(`[WS] Group ${id} created. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('chat:new', { chatId: id });
        }
      }
    }
  })();

  // Group Updated
  const groupUpdatedSub = addSub(natsConnection.subscribe(EventSubjects.GROUP_UPDATED));
  (async () => {
    for await (const msg of groupUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { id, memberIds, ...updates } = event.payload;
      console.log(`[WS] Group ${id} updated. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('chat:updated', { chatId: id, ...updates });
        }
      }
    }
  })();

  // Group Deleted
  const groupDeletedSub = addSub(natsConnection.subscribe(EventSubjects.GROUP_DELETED));
  (async () => {
    for await (const msg of groupDeletedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { id, memberIds } = event.payload;
      console.log(`[WS] Group ${id} deleted. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('chat:deleted', { chatId: id });
        }
      }
    }
  })();

  // Group Member Added
  const groupMemberAddedSub = addSub(natsConnection.subscribe(EventSubjects.GROUP_MEMBER_ADDED));
  (async () => {
    for await (const msg of groupMemberAddedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, userId, memberIds } = event.payload;
      console.log(`[WS] User ${userId} joined group ${chatId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('chat:member_updated', { chatId, userId, action: 'joined' });
        }
      }
    }
  })();

  // Group Member Removed
  const groupMemberRemovedSub = addSub(natsConnection.subscribe(EventSubjects.GROUP_MEMBER_REMOVED));
  (async () => {
    for await (const msg of groupMemberRemovedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, userId, memberIds, reason } = event.payload;
      console.log(`[WS] User ${userId} removed from group ${chatId}`);
      io.to(`user:${userId}`).emit('chat:member_removed', { chatId, userId, reason });
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          if (uid !== userId) {
            io.to(`user:${uid}`).emit('chat:member_updated', { chatId, userId, action: 'removed' });
          }
        }
      }
    }
  })();

  // Group Member Role Updated
  const groupMemberRoleUpdatedSub = addSub(natsConnection.subscribe(EventSubjects.GROUP_MEMBER_ROLE_UPDATED));
  (async () => {
    for await (const msg of groupMemberRoleUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, userId, role, memberIds } = event.payload;
      console.log(`[WS] Role updated for user ${userId} in group ${chatId} to ${role}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('chat:role_updated', { chatId, memberId: userId, newRole: role });
        }
      }
    }
  })();

  // Channel Created
  const channelCreatedSub = addSub(natsConnection.subscribe(EventSubjects.CHANNEL_CREATED));
  (async () => {
    for await (const msg of channelCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { workspaceId, channel, memberIds } = event.payload;
      console.log(`[WS] Channel ${channel?.id} created in workspace ${workspaceId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('channel:new', { workspaceId, channel });
        }
      }
    }
  })();

  // Channel Updated
  const channelUpdatedSub = addSub(natsConnection.subscribe(EventSubjects.CHANNEL_UPDATED));
  (async () => {
    for await (const msg of channelUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { id, workspaceId, memberIds, ...updates } = event.payload;
      console.log(`[WS] Channel ${id} updated. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('channel:updated', { channelId: id, workspaceId, ...updates });
        }
      }
    }
  })();

  // Channel Deleted
  const channelDeletedSub = addSub(natsConnection.subscribe(EventSubjects.CHANNEL_DELETED));
  (async () => {
    for await (const msg of channelDeletedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { id, workspaceId, memberIds } = event.payload;
      console.log(`[WS] Channel ${id} deleted. Notifying members.`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('channel:deleted', { channelId: id, workspaceId });
        }
      }
    }
  })();

  // Task Created
  const taskCreatedSub = addSub(natsConnection.subscribe(EventSubjects.TASK_CREATED));
  (async () => {
    for await (const msg of taskCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, task, memberIds } = event.payload;
      console.log(`[WS] Task created in chat ${chatId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('task:new', { chatId, task });
        }
      }
    }
  })();

  // Task Updated
  const taskUpdatedSub = addSub(natsConnection.subscribe(EventSubjects.TASK_UPDATED));
  (async () => {
    for await (const msg of taskUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { taskId, chatId, memberIds, ...updates } = event.payload;
      console.log(`[WS] Task ${taskId} updated in chat ${chatId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('task:updated', { taskId, chatId, ...updates });
        }
      }
    }
  })();

  // Join Request Created
  const joinRequestCreatedSub = addSub(natsConnection.subscribe(EventSubjects.GROUP_JOIN_REQUEST_CREATED));
  (async () => {
    for await (const msg of joinRequestCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, requestId, accountId, adminIds } = event.payload;
      console.log(`[WS] New join request for group ${chatId}`);
      if (Array.isArray(adminIds)) {
        for (const aid of adminIds) {
          io.to(`user:${aid}`).emit('chat:join_request:new', { chatId, requestId, accountId });
        }
      }
    }
  })();

  // Join Request Updated
  const joinRequestUpdatedSub = addSub(natsConnection.subscribe(EventSubjects.GROUP_JOIN_REQUEST_UPDATED));
  (async () => {
    for await (const msg of joinRequestUpdatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, requestId, accountId, status, adminIds } = event.payload;
      console.log(`[WS] Join request ${requestId} updated to ${status}`);
      if (Array.isArray(adminIds)) {
        for (const aid of adminIds) {
          io.to(`user:${aid}`).emit('chat:join_request:updated', { chatId, requestId, accountId, status });
        }
      }
      // Also notify the applicant
      io.to(`user:${accountId}`).emit('chat:join_request:status', { chatId, requestId, status });
    }
  })();

  // Channel Archived
  const channelArchivedSub = addSub(natsConnection.subscribe(EventSubjects.CHANNEL_ARCHIVED));
  (async () => {
    for await (const msg of channelArchivedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { id, workspaceId, memberIds } = event.payload;
      console.log(`[WS] Channel ${id} archived in workspace ${workspaceId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('channel:archived', { channelId: id, workspaceId });
        }
      }
    }
  })();

  // Channel Member Added
  const channelMemberAddedSub = addSub(natsConnection.subscribe(EventSubjects.CHANNEL_MEMBER_ADDED));
  (async () => {
    for await (const msg of channelMemberAddedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { channelId, userId, memberIds } = event.payload;
      console.log(`[WS] User ${userId} joined channel ${channelId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('channel:member_updated', { channelId, userId, action: 'joined' });
        }
      }
    }
  })();

  // Channel Member Removed
  const channelMemberRemovedSub = addSub(natsConnection.subscribe(EventSubjects.CHANNEL_MEMBER_REMOVED));
  (async () => {
    for await (const msg of channelMemberRemovedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { channelId, userId, memberIds } = event.payload;
      console.log(`[WS] User ${userId} left channel ${channelId}`);
      io.to(`user:${userId}`).emit('channel:member_removed', { channelId, userId });
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          if (uid !== userId) {
            io.to(`user:${uid}`).emit('channel:member_updated', { channelId, userId, action: 'removed' });
          }
        }
      }
    }
  })();

  // Task Deleted
  const taskDeletedSub = addSub(natsConnection.subscribe(EventSubjects.TASK_DELETED));
  (async () => {
    for await (const msg of taskDeletedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { taskId, chatId, memberIds } = event.payload;
      console.log(`[WS] Task ${taskId} deleted in chat ${chatId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('task:deleted', { taskId, chatId });
        }
      }
    }
  })();

  // Message Edited
  const messageEditedSub = addSub(natsConnection.subscribe(EventSubjects.MESSAGE_EDITED));
  (async () => {
    for await (const msg of messageEditedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { messageId, chatId, content, memberIds } = event.payload;
      console.log(`[WS] Message ${messageId} edited in chat ${chatId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('message:edited', { messageId, chatId, content });
        }
      }
    }
  })();

  // Message Reaction (Scalable flow)
  const messageReactionSub = addSub(natsConnection.subscribe(EventSubjects.MESSAGE_REACTION));
  (async () => {
    for await (const msg of messageReactionSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { messageId, chatId, userId, userName, emoji, action, memberIds } = event.payload;
      console.log(`[WS] Reaction ${action} on message ${messageId} in chat ${chatId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('message:reacted', { messageId, chatId, userId, userName, emoji, action });
        }
      }
    }
  })();

  // User Mentioned
  const userMentionedSub = addSub(natsConnection.subscribe(EventSubjects.USER_MENTIONED));
  (async () => {
    for await (const msg of userMentionedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, chatId, messageId, mentionerName } = event.payload;
      console.log(`[WS] User ${userId} mentioned in chat ${chatId}`);
      io.to(`user:${userId}`).emit('message:mention', { chatId, messageId, mentionerName });
    }
  })();

  // Thread Reply Created
  const threadReplyCreatedSub = addSub(natsConnection.subscribe(EventSubjects.THREAD_REPLY_CREATED));
  (async () => {
    for await (const msg of threadReplyCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { parentMessageId, chatId, reply, memberIds } = event.payload;
      console.log(`[WS] New thread reply in chat ${chatId} for message ${parentMessageId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('thread:reply:new', { parentMessageId, chatId, reply });
        }
      }
    }
  })();

  // Chat File Uploaded
  const chatFileUploadedSub = addSub(natsConnection.subscribe(EventSubjects.CHAT_FILE_UPLOADED));
  (async () => {
    for await (const msg of chatFileUploadedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, file, memberIds } = event.payload;
      console.log(`[WS] New file uploaded in chat ${chatId}`);
      if (Array.isArray(memberIds)) {
        for (const uid of memberIds) {
          io.to(`user:${uid}`).emit('chat:file:new', { chatId, file });
        }
      }
    }
  })();

  // Task Deadline Approaching
  const taskDeadlineSub = addSub(natsConnection.subscribe(EventSubjects.TASK_DEADLINE_APPROACHING));
  (async () => {
    for await (const msg of taskDeadlineSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { taskId, chatId, title, deadline, assignedTo } = event.payload;
      console.log(`[WS] Task deadline approaching for ${taskId} in chat ${chatId}`);
      if (Array.isArray(assignedTo)) {
        for (const uid of assignedTo) {
          io.to(`user:${uid}`).emit('task:deadline_warning', { taskId, chatId, title, deadline });
        }
      }
    }
  })();

  // Notification Created
  const notificationSub = addSub(natsConnection.subscribe(EventSubjects.NOTIFICATION_CREATED));
  (async () => {
    for await (const msg of notificationSub) {
      try {
        const event = jsonCodec.decode(msg.data) as any;
        const notificationData = event.payload;
        const { userId } = notificationData;
        console.log(`[WS] New notification for user ${userId}: ${notificationData.title}`);
        io.to(`user:${userId}`).emit('notification:new', { ...notificationData, timestamp: event.timestamp });
      } catch (err) {
        console.error('[WS] Error processing notification:new:', err);
      }
    }
  })();
  
  // System Broadcast
  const systemBroadcastSub = addSub(natsConnection.subscribe(EventSubjects.SYSTEM_BROADCAST));
  (async () => {
    for await (const msg of systemBroadcastSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { title, body, type, data } = event.payload;
      console.log(`[WS] System broadcast: ${title}`);
      io.emit('system:broadcast', { title, body, type, data, timestamp: event.timestamp });
    }
  })();


  console.log('[WS Gateway] Subscribed to NATS events (including all friend actions)');
}

// ============= PUBLISH EVENTS =============

function publishEvent(subject: string, payload: any) {
  if (!natsConnection) {
    console.warn(`[WS Gateway] NATS not connected. Cannot publish event on ${subject}`);
    return;
  }
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

    const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string; id?: string; name?: string; role?: string; orgId?: string };
    socket.userId = decoded.sub || decoded.id || '';
    socket.userName = decoded.name || 'User';
    socket.role = decoded.role || 'WORKSPACE_MEMBER';
    socket.orgId = decoded.orgId;
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
  console.log(`[WS] User ${userId} joined room: user:${userId}`);

  // Join admin room if applicable
  if (socket.role === 'SUPER_ADMIN' || socket.role === 'ADMIN') {
    socket.join('admins');
    socket.join('role:SUPER_ADMIN'); // Specific room for system-wide broadcasts
    console.log(`[WS] Admin ${userId} joined room: admins`);
  }

  // Join organization room
  if (socket.orgId) {
    socket.join(`org:${socket.orgId}`);
    console.log(`[WS] User ${userId} joined room: org:${socket.orgId}`);
  }

  // Join workspace rooms if any (optional, usually handled by client join events)
  
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

      const response = await fetch(`${messagingServiceUrl}/messages/${chatId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
          'x-user-name': userName,
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

  // ============= AI ASSISTANT HANDLER (Phase 1) =============

  socket.on('chat:ai_query', async (data: { chatId: string; message: string; conversationId?: number }) => {
    const { chatId, message, conversationId } = data;
    if (!message?.trim()) return;

    const aiServiceUrl = process.env.SPRING_AI_URL || 'http://localhost:8080';
    console.log(`[AI] Using AI Service URL: ${aiServiceUrl}`);
    const sessionId = `ai_${Date.now()}`;

    // Notify user AI is thinking
    io.to(`user:${userId}`).emit('ai:thinking', { chatId, sessionId });
    console.log(`[AI] User ${userName} queried AI in chat ${chatId}: "${message.slice(0, 60)}..."`);

    try {
      // Step 1: Ensure conversation exists (create if not provided)
      let activeConversationId = conversationId;
      if (!activeConversationId) {
        const convRes = await fetch(`${aiServiceUrl}/chat/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          body: JSON.stringify({ title: `Chat ${chatId}`, chatId }),
        });
        if (convRes.ok) {
          const conv = await convRes.json() as any;
          activeConversationId = conv.id;
          // Tell client which conversationId was used so it can resume later
          io.to(`user:${userId}`).emit('ai:conversation_id', { chatId, conversationId: activeConversationId, sessionId });
        }
      }

      // Step 2: Call streaming RAG endpoint
      const streamRes = await fetch(`${aiServiceUrl}/chat/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ conversationId: activeConversationId, message }),
      });

      if (!streamRes.ok || !streamRes.body) {
        throw new Error(`AI service returned ${streamRes.status}`);
      }

      // Step 3: Pipe SSE tokens → Socket.IO
      const reader = (streamRes.body as any).getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        let lineEndIndex;
        while ((lineEndIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, lineEndIndex).trim();
          buffer = buffer.slice(lineEndIndex + 1);

          if (line.startsWith('data:')) {
            const content = line.replace(/^data:\s*/, '');
            if (content && content !== '[DONE]') {
              fullResponse += content;
              io.to(`user:${userId}`).emit('ai:token', { chatId, token: content, sessionId });
            }
          }
        }
      }

      // Step 4: Signal completion with full response
      io.to(`user:${userId}`).emit('ai:done', {
        chatId,
        response: fullResponse,
        sessionId,
        conversationId: activeConversationId,
      });
      console.log(`[AI] Completed response for ${userName} in chat ${chatId} (${fullResponse.length} chars)`);

    } catch (err: any) {
      console.error(`[AI] Error processing query for ${userName}:`, err.message);
      io.to(`user:${userId}`).emit('ai:error', {
        chatId,
        sessionId,
        error: 'AI service is currently unavailable. Please try again later.',
      });
    }
  });

  // ============= AI AGENT HANDLER (Phase 2 — Tool Calling) =============

  socket.on('chat:agent_query', async (data: { chatId: string; message: string; conversationId?: number; workspaceId?: string }) => {
    const { chatId, message, conversationId, workspaceId } = data;
    if (!message?.trim()) return;

    const aiServiceUrl = process.env.SPRING_AI_URL || 'http://localhost:8080';
    console.log(`[Agent] Using AI Service URL: ${aiServiceUrl}`);
    const sessionId = `agent_${Date.now()}`;

    // Notify user — agent is "thinking" (may call tools before streaming)
    io.to(`user:${userId}`).emit('ai:thinking', { chatId, sessionId, mode: 'agent' });
    console.log(`[Agent] User ${userName} agent query in chat ${chatId}: "${message.slice(0, 60)}..."`);

    try {
      // Call /agent/chat — it auto-creates conversation and executes tools
      const agentRes = await fetch(`${aiServiceUrl}/agent/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({
          conversationId: conversationId || null,
          message,
          chatId,
          workspaceId: workspaceId || null,
        }),
      });

      if (!agentRes.ok || !agentRes.body) {
        throw new Error(`Agent service returned ${agentRes.status}`);
      }

      // Pipe SSE tokens → Socket.IO (same pattern as Phase 1)
      const reader = (agentRes.body as any).getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        let lineEndIndex;
        while ((lineEndIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, lineEndIndex).trim();
          buffer = buffer.slice(lineEndIndex + 1);

          if (line.startsWith('data:')) {
            const content = line.replace(/^data:\s*/, '');
            if (content && content !== '[DONE]') {
              fullResponse += content;
              io.to(`user:${userId}`).emit('ai:token', { chatId, token: content, sessionId });
            }
          }
        }
      }

      io.to(`user:${userId}`).emit('ai:done', {
        chatId,
        response: fullResponse,
        sessionId,
        mode: 'agent',
      });
      console.log(`[Agent] Completed for ${userName}, chars=${fullResponse.length}`);

    } catch (err: any) {
      console.error(`[Agent] Error for ${userName}:`, err.message);
      io.to(`user:${userId}`).emit('ai:error', {
        chatId,
        sessionId,
        error: 'AI Agent is currently unavailable. Please try again.',
      });
    }
  });

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
