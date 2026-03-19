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

// Health check
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ws-gateway',
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

  socket.on('disconnect', () => {
    console.log(`[WS] User disconnected: ${userName} (${userId})`);
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🔌 WS Gateway running on port ${PORT}`);
  console.log('='.repeat(50));
});