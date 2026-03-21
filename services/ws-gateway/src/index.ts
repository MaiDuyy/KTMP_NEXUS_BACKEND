// services/ws-gateway/src/index.ts
// WebSocket Gateway - Migrate từ src/services/socket.service.ts

import 'dotenv/config';
import http from 'http';
import express from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { connect, NatsConnection, JSONCodec } from 'nats';

const app = express();
const httpServer = http.createServer(app);

// Config
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';

// ============= TYPES =============

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userName?: string;
}

// Map lưu trữ users đang online
const onlineUsers = new Map<string, Set<string>>();

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
};

// ============= HEALTH CHECK =============

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ws-gateway',
    connections: io?.engine?.clientsCount || 0,
    onlineUsers: onlineUsers.size,
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
});

// ============= REDIS ADAPTER (Optional) =============

async function setupRedisAdapter() {
  try {
    const pubClient = new Redis(REDIS_URL);
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient ) as any);
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

    // Subscribe to events for realtime broadcast
    subscribeToNatsEvents();
  } catch (error) {
    console.warn('[WS Gateway] NATS not available');
  }
}

function subscribeToNatsEvents() {
  if (!natsConnection) return;

  // Message Created -> Broadcast to chat room
  const msgCreatedSub = natsConnection.subscribe(EventSubjects.MESSAGE_CREATED);
  (async () => {
    for await (const msg of msgCreatedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, ...messageData } = event.payload;
      io.to(`chat:${chatId}`).emit('message:new', {
        message: messageData,
        chatId,
      });
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
      io.to(`chat:${chatId}`).emit('message:reacted', reactionData);
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

  // ============= NEW: Thread Reply Created =============
  const threadReplySub = natsConnection.subscribe('thread.reply.created');
  (async () => {
    for await (const msg of threadReplySub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, parentId, ...replyData } = event.payload;
      // Broadcast to chat room
      io.to(`chat:${chatId}`).emit('thread:reply', {
        chatId,
        parentId,
        reply: replyData,
      });
      // Also broadcast to thread-specific room
      io.to(`thread:${parentId}`).emit('thread:reply', {
        parentId,
        reply: replyData,
      });
    }
  })();

  // ============= NEW: User Mentioned =============
  const userMentionedSub = natsConnection.subscribe('user.mentioned');
  (async () => {
    for await (const msg of userMentionedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { userId, chatId, messageId, mentionedBy } = event.payload;
      // Send notification to specific user
      io.to(`user:${userId}`).emit('mention:new', {
        chatId,
        messageId,
        mentionedBy,
        timestamp: event.timestamp,
      });
    }
  })();

  // ============= NEW: Mention Broadcast (@here, @channel) =============
  const mentionBroadcastSub = natsConnection.subscribe('mention.broadcast');
  (async () => {
    for await (const msg of mentionBroadcastSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, messageId, mentionedBy, types } = event.payload;
      // Broadcast to the whole chat room (client handles filtering)
      io.to(`chat:${chatId}`).emit('mention:broadcast', {
        chatId,
        messageId,
        mentionedBy,
        types, // ['HERE', 'CHANNEL']
      });
    }
  })();

  // ============= NEW: Message Edited =============
  const msgEditedSub = natsConnection.subscribe('message.edited');
  (async () => {
    for await (const msg of msgEditedSub) {
      const event = jsonCodec.decode(msg.data) as any;
      const { chatId, messageId, content, editedAt } = event.payload;
      io.to(`chat:${chatId}`).emit('message:edited', {
        chatId,
        messageId,
        content,
        editedAt,
      });
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

  console.log('[WS Gateway] Subscribed to NATS events (including threads, mentions)');
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
    const token =
      socket.handshake.auth.token ||
      socket.handshake.headers.authorization?.split(' ')[1];

    if (!token) {
      return next(new Error('Authentication required'));
    }

    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; name?: string };
    socket.userId = decoded.id;
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

  // Add to online users
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId)!.add(socket.id);

  // Join personal room
  socket.join(`user:${userId}`);

  // Notify others that user is online
  publishEvent(EventSubjects.USER_ONLINE, { userId, userName });

  // Send online users list to new connection
  socket.emit('users:online', { userIds: Array.from(onlineUsers.keys()) });

  // ============= EVENT HANDLERS =============

  // Join chat room
  socket.on('chat:join', (data) => {
    const { chatId } = data;
    socket.join(`chat:${chatId}`);
    console.log(`[WS] ${userName} joined chat:${chatId}`);
  });

  // Leave chat room
  socket.on('chat:leave', (data) => {
    const { chatId } = data;
    socket.leave(`chat:${chatId}`);
  });

  // ============= NEW: Thread Room Events =============
  
  // Join thread room (for thread-specific updates)
  socket.on('thread:join', (data) => {
    const { messageId } = data;
    socket.join(`thread:${messageId}`);
    console.log(`[WS] ${userName} joined thread:${messageId}`);
  });

  // Leave thread room
  socket.on('thread:leave', (data) => {
    const { messageId } = data;
    socket.leave(`thread:${messageId}`);
  });

  // Typing start
  socket.on('typing:start', (data) => {
    const { chatId } = data;
    socket.to(`chat:${chatId}`).emit('typing:start', { chatId, userId, userName });
    publishEvent(EventSubjects.TYPING_START, { chatId, userId, userName });
  });

  // Typing stop
  socket.on('typing:stop', (data) => {
    const { chatId } = data;
    socket.to(`chat:${chatId}`).emit('typing:stop', { chatId, userId });
    publishEvent(EventSubjects.TYPING_STOP, { chatId, userId });
  });

  // Mark message as read (emit via socket for immediate feedback)
  socket.on('message:read', (data) => {
    const { chatId } = data;
    socket.to(`chat:${chatId}`).emit('message:read', { chatId, userId });
  });

  // React to message (client-side quick feedback)
  socket.on('message:react', async (data) => {
    const { messageId, chatId, emoji } = data;
    // Emit to all in chat
    io.to(`chat:${chatId}`).emit('message:reacted', {
      messageId,
      userId,
      userName,
      emoji,
      action: 'added',
    });
  });

  // Pin message
  socket.on('message:pin', (data) => {
    const { messageId, chatId, pin } = data;
    io.to(`chat:${chatId}`).emit('message:pinned', {
      messageId,
      chatId,
      pin,
      userId,
      userName,
    });
  });

  // ============= DISCONNECT =============

  socket.on('disconnect', async () => {
    console.log(`[WS] User disconnected: ${userName} (${userId})`);

    // Remove from online users
    const userSockets = onlineUsers.get(userId);
    if (userSockets) {
      userSockets.delete(socket.id);

      // If no more sockets, mark as offline
      if (userSockets.size === 0) {
        onlineUsers.delete(userId);
        
        const lastSeen = new Date().toISOString();
        publishEvent(EventSubjects.USER_OFFLINE, { userId, lastSeen });
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
    console.log('='.repeat(50));
  });
}

start();

export { io };
