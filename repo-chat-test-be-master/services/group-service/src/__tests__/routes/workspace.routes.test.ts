import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

// Import mocks before importing routes
import { mockPrisma, mockPublishEvent, mockLogger } from '../mocks.js';

// Dynamic import for ESM module mocking
let workspaceRoutes: typeof import('../../routes/workspace.routes.js').workspaceRoutes;
let asyncHandler: typeof import('../../middleware/errorHandler.js').asyncHandler;

beforeAll(async () => {
  ({ workspaceRoutes } = await import('../../routes/workspace.routes.js'));
  ({ asyncHandler } = await import('../../middleware/errorHandler.js'));
});

// Create test app
function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/workspaces', workspaceRoutes);
  // Simple error handler for tests
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ success: false, message: err.message });
  });
  return app;
}

describe('Workspace Routes', () => {
  let app: Express;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==================== POST /workspaces ====================
  describe('POST /workspaces - Create Workspace', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .post('/workspaces')
        .send({ name: 'Test Workspace' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Chưa đăng nhập!');
    });

    it('should return 400 if no name provided', async () => {
      const res = await request(app)
        .post('/workspaces')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Tên workspace là bắt buộc!');
    });

    it('should create workspace successfully', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue(null);
      mockPrisma.workspace.create.mockResolvedValue({
        id: 'ws-1',
        name: 'Test Workspace',
        slug: 'test-workspace',
        ownerId: 'user-1',
        members: [{ userId: 'user-1', role: 'OWNER' }],
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/workspaces')
        .set('x-user-id', 'user-1')
        .send({ name: 'Test Workspace', description: 'A test workspace' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.workspace.id).toBe('ws-1');
    });
  });

  // ==================== GET /workspaces ====================
  describe('GET /workspaces - List Workspaces', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).get('/workspaces');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should list user workspaces', async () => {
      // getUserWorkspaces uses workspace.findMany, not workspaceMember.findMany
      mockPrisma.workspace.findMany.mockResolvedValue([
        {
          id: 'ws-1',
          name: 'Workspace 1',
          slug: 'ws-1',
          description: null,
          icon: null,
          isPublic: false,
          updatedAt: new Date(),
          members: [{ role: 'OWNER' }],
          _count: { members: 5, channels: 3 },
        },
        {
          id: 'ws-2',
          name: 'Workspace 2',
          slug: 'ws-2',
          description: null,
          icon: null,
          isPublic: false,
          updatedAt: new Date(),
          members: [{ role: 'MEMBER' }],
          _count: { members: 10, channels: 5 },
        },
      ]);

      const res = await request(app)
        .get('/workspaces')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.workspaces).toHaveLength(2);
    });
  });

  // ==================== GET /workspaces/:id ====================
  describe('GET /workspaces/:id - Get Workspace', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).get('/workspaces/ws-1');

      expect(res.status).toBe(401);
    });

    it('should return workspace details', async () => {
      mockPrisma.workspace.findFirst.mockResolvedValue({
        id: 'ws-1',
        name: 'Test Workspace',
        slug: 'test-workspace',
        isPublic: false,
        members: [{ id: 'm-1', userId: 'user-1', role: 'OWNER' }],
        channels: [],
        categories: [],
        _count: { members: 1, channels: 0 },
      });

      const res = await request(app)
        .get('/workspaces/ws-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.workspace.id).toBe('ws-1');
    });
  });

  // ==================== PUT /workspaces/:id ====================
  describe('PUT /workspaces/:id - Update Workspace', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .put('/workspaces/ws-1')
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(401);
    });

    it('should update workspace successfully', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [{ userId: 'user-1', role: 'OWNER' }],
      });
      mockPrisma.workspace.update.mockResolvedValue({
        id: 'ws-1',
        name: 'Updated Name',
      });

      const res = await request(app)
        .put('/workspaces/ws-1')
        .set('x-user-id', 'user-1')
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== DELETE /workspaces/:id ====================
  describe('DELETE /workspaces/:id - Delete Workspace', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).delete('/workspaces/ws-1');

      expect(res.status).toBe(401);
    });

    it('should delete workspace by owner', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [{ userId: 'owner-1', role: 'OWNER' }],
      });
      mockPrisma.workspace.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/workspaces/ws-1')
        .set('x-user-id', 'owner-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== MEMBER MANAGEMENT ====================
  describe('POST /workspaces/:id/members - Add Member', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .post('/workspaces/ws-1/members')
        .send({ targetUserId: 'new-user' });

      expect(res.status).toBe(401);
    });

    it('should return 400 if no targetUserId', async () => {
      const res = await request(app)
        .post('/workspaces/ws-1/members')
        .set('x-user-id', 'admin-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('targetUserId là bắt buộc!');
    });

    it('should add member successfully', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [{ userId: 'admin-1', role: 'ADMIN' }],
      });
      mockPrisma.workspaceMember.create.mockResolvedValue({
        id: 'm-2',
        userId: 'new-user',
        role: 'MEMBER',
      });
      mockPrisma.channel.findMany.mockResolvedValue([]);
      mockPrisma.channelMember.createMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .post('/workspaces/ws-1/members')
        .set('x-user-id', 'admin-1')
        .send({ targetUserId: 'new-user', role: 'MEMBER' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });

  describe('DELETE /workspaces/:id/members/:targetUserId - Remove Member', () => {
    it('should remove member successfully', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [
          { id: 'm-1', userId: 'admin-1', role: 'ADMIN' },
          { id: 'm-2', userId: 'member-1', role: 'MEMBER' },
        ],
      });
      mockPrisma.workspaceMember.delete.mockResolvedValue({});
      mockPrisma.channelMember.deleteMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .delete('/workspaces/ws-1/members/member-1')
        .set('x-user-id', 'admin-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /workspaces/:id/leave - Leave Workspace', () => {
    it('should allow member to leave', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        members: [
          { id: 'm-1', userId: 'owner-1', role: 'OWNER' },
          { id: 'm-2', userId: 'member-1', role: 'MEMBER' },
        ],
      });
      mockPrisma.workspaceMember.delete.mockResolvedValue({});
      mockPrisma.channelMember.deleteMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .post('/workspaces/ws-1/leave')
        .set('x-user-id', 'member-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Đã rời workspace!');
    });
  });
});
