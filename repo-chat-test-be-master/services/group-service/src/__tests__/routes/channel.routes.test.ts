import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

// Import mocks before importing routes
import { mockPrisma, mockPublishEvent } from '../mocks.js';

// Dynamic import for ESM module mocking
let channelRoutes: typeof import('../../routes/channel.routes.js').channelRoutes;

beforeAll(async () => {
  ({ channelRoutes } = await import('../../routes/channel.routes.js'));
});

// Create test app
function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/', channelRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ success: false, message: err.message });
  });
  return app;
}

describe('Channel Routes', () => {
  let app: Express;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==================== CREATE CHANNEL ====================
  describe('POST /workspaces/:wsId/channels - Create Channel', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .post('/workspaces/ws-1/channels')
        .send({ name: 'general' });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Chưa đăng nhập!');
    });

    it('should return 400 if no name provided', async () => {
      const res = await request(app)
        .post('/workspaces/ws-1/channels')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Tên channel là bắt buộc!');
    });

    it('should create channel successfully', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ userId: 'user-1', role: 'ADMIN' });
      mockPrisma.channel.findUnique.mockResolvedValue(null);
      mockPrisma.channel.create.mockResolvedValue({
        id: 'ch-1',
        name: 'general',
        type: 'PUBLIC',
        workspaceId: 'ws-1',
        createdAt: new Date(),
        members: [{ userId: 'user-1', role: 'OWNER' }],
        category: null,
      });

      const res = await request(app)
        .post('/workspaces/ws-1/channels')
        .set('x-user-id', 'user-1')
        .send({ name: 'general', type: 'PUBLIC' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.channel.name).toBe('general');
    });
  });

  // ==================== LIST CHANNELS ====================
  describe('GET /workspaces/:wsId/channels - List Channels', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).get('/workspaces/ws-1/channels');
      expect(res.status).toBe(401);
    });

    it('should list channels in workspace', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
      mockPrisma.channel.findMany.mockResolvedValue([
        { id: 'ch-1', name: 'general', type: 'PUBLIC', members: [], _count: { members: 10 } },
        { id: 'ch-2', name: 'random', type: 'PUBLIC', members: [], _count: { members: 5 } },
      ]);

      const res = await request(app)
        .get('/workspaces/ws-1/channels')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== GET CHANNEL ====================
  describe('GET /channels/:id - Get Channel Details', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).get('/channels/ch-1');
      expect(res.status).toBe(401);
    });

    it('should return channel details', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        name: 'general',
        type: 'PUBLIC',
        members: [{ id: 'm-1', userId: 'user-1', role: 'MEMBER' }],
        category: null,
        _count: { members: 1 },
      });

      const res = await request(app)
        .get('/channels/ch-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.channel.id).toBe('ch-1');
    });
  });

  // ==================== UPDATE CHANNEL ====================
  describe('PUT /channels/:id - Update Channel', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .put('/channels/ch-1')
        .send({ name: 'updated' });

      expect(res.status).toBe(401);
    });

    it('should update channel successfully', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'admin-1', role: 'ADMIN' }],
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
      mockPrisma.channel.update.mockResolvedValue({
        id: 'ch-1',
        name: 'updated',
      });

      const res = await request(app)
        .put('/channels/ch-1')
        .set('x-user-id', 'admin-1')
        .send({ name: 'updated' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== DELETE CHANNEL ====================
  describe('DELETE /channels/:id - Delete Channel', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).delete('/channels/ch-1');
      expect(res.status).toBe(401);
    });

    it('should delete channel by owner', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'owner-1', role: 'OWNER' }],
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
      mockPrisma.channel.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/channels/ch-1')
        .set('x-user-id', 'owner-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== ARCHIVE CHANNEL ====================
  describe('POST /channels/:id/archive - Archive Channel', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).post('/channels/ch-1/archive');
      expect(res.status).toBe(401);
    });

    it('should archive channel by admin', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'admin-1', role: 'ADMIN' }],
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);
      mockPrisma.channel.update.mockResolvedValue({
        id: 'ch-1',
        isArchived: true,
      });

      const res = await request(app)
        .post('/channels/ch-1/archive')
        .set('x-user-id', 'admin-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== JOIN/LEAVE CHANNEL ====================
  describe('POST /channels/:id/join - Join Public Channel', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).post('/channels/ch-1/join');
      expect(res.status).toBe(401);
    });

    it('should join public channel successfully', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        type: 'PUBLIC',
        isArchived: false,
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ userId: 'user-1', role: 'MEMBER' });
      mockPrisma.channelMember.findUnique.mockResolvedValue(null);
      mockPrisma.channelMember.create.mockResolvedValue({
        id: 'm-1',
        channelId: 'ch-1',
        userId: 'user-1',
        role: 'MEMBER',
      });

      const res = await request(app)
        .post('/channels/ch-1/join')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /channels/:id/leave - Leave Channel', () => {
    it('should leave channel successfully', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ id: 'm-1', userId: 'user-1', role: 'MEMBER' }],
      });
      mockPrisma.channelMember.delete.mockResolvedValue({});

      const res = await request(app)
        .post('/channels/ch-1/leave')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== MEMBER MANAGEMENT ====================
  describe('POST /channels/:id/members - Add Member', () => {
    it('should return 400 if no targetUserId', async () => {
      const res = await request(app)
        .post('/channels/ch-1/members')
        .set('x-user-id', 'admin-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('targetUserId là bắt buộc!');
    });

    it('should add member to channel', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
        members: [{ userId: 'admin-1', role: 'ADMIN' }],
      });
      mockPrisma.workspaceMember.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ userId: 'new-user', role: 'MEMBER' });
      mockPrisma.channelMember.create.mockResolvedValue({
        id: 'm-2',
        channelId: 'ch-1',
        userId: 'new-user',
        role: 'MEMBER',
      });

      const res = await request(app)
        .post('/channels/ch-1/members')
        .set('x-user-id', 'admin-1')
        .send({ targetUserId: 'new-user' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== BROWSE CHANNELS ====================
  describe('GET /workspaces/:wsId/channels/browse - Browse Public Channels', () => {
    it('should return paginated public channels', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
      mockPrisma.channel.findMany.mockResolvedValue([
        { id: 'ch-1', name: 'general', members: [], _count: { members: 10 } },
      ]);
      mockPrisma.channel.count.mockResolvedValue(1);

      const res = await request(app)
        .get('/workspaces/ws-1/channels/browse')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
