import 'dotenv/config';
import http from 'http';
import express from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { connect, NatsConnection, JSONCodec } from 'nats';

const app = express();
const httpServer = http.createServer(app);

// Config
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';

// Types
interface AuthenticatedSocket extends Socket {
  userId?: string;
  userName?: string;
}

// Online users: userId -> Set of socket ids
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

// Health check
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ws-gateway',
    connections: io?.engine?.clientsCount || 0,
    onlineUsers: onlineUsers.size,
    timestamp: new Date().toISOString(),
  });
});

// Socket.IO setup
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: CORS_ORIGIN.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

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

// Authentication middleware
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

// Connection handler
io.on('connection', (socket: AuthenticatedSocket) => {
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

  // Send online users list to this client
  socket.emit('users:online', { userIds: Array.from(onlineUsers.keys()) });

  // Event handlers
  socket.on('chat:join', (data: { chatId: string }) => {
    const { chatId } = data;
    socket.join(`chat:${chatId}`);
    console.log(`[WS] ${userName} joined chat:${chatId}`);
  });

  socket.on('chat:leave', (data: { chatId: string }) => {
    const { chatId } = data;
    socket.leave(`chat:${chatId}`);
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
  const userId = socket.userId!;
  const userName = socket.userName!;

  socket.on('chat:join', ({ chatId }) => {
    socket.join(`chat:${chatId}`);
  });

  socket.on('chat:leave', ({ chatId }) => {
    socket.leave(`chat:${chatId}`);
  });

  socket.on('typing:start', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('typing:start', {
      chatId,
      userId,
      userName,
    });
  });

  socket.on('typing:stop', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('typing:stop', {
      chatId,
      userId,
    });
  });
});
socket.on('message:read', ({ chatId }) => {
  socket.to(`chat:${chatId}`).emit('message:read', { chatId, userId });
});

socket.on('message:react', ({ chatId, messageId, emoji }) => {
  io.to(`chat:${chatId}`).emit('message:reacted', {
    messageId,
    userId,
    emoji,
  });
});

socket.on('message:pin', ({ chatId, messageId, pin }) => {
  io.to(`chat:${chatId}`).emit('message:pinned', {
    chatId,
    messageId,
    pin,
  });
});

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[WS] User disconnected: ${userName} (${userId})`);

    const userSockets = onlineUsers.get(userId);
    if (userSockets) {
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        onlineUsers.delete(userId);
      }
    }
  });
});

// Start server
async function start() {
  await setupNats();

  httpServer.listen(PORT, () => {
    console.log(`WS Gateway running on ${PORT}`);
  });
}

start();