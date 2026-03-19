import 'dotenv/config';
import http from 'http';
import express from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

const app = express();
const httpServer = http.createServer(app);

// Config
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

// Types
interface AuthenticatedSocket extends Socket {
  userId?: string;
  userName?: string;
}

// Online users: userId -> Set of socket ids
const onlineUsers = new Map<string, Set<string>>();

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
httpServer.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🔌 WS Gateway running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
  console.log('='.repeat(50));
});