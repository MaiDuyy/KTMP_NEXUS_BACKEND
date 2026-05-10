import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

// Import mocks before importing routes
import { mockPrisma } from '../mocks.js';

// Dynamic import for ESM module mocking
let channelCategoryRoutes: typeof import('../../routes/channel-category.routes.js').channelCategoryRoutes;

beforeAll(async () => {
  ({ channelCategoryRoutes } = await import('../../routes/channel-category.routes.js'));
});

// Create test app
function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/', channelCategoryRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ success: false, message: err.message });
  });
  return app;
}

describe('Channel Category Routes', () => {
  let app: Express;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==================== CREATE CATEGORY ====================
  describe('POST /workspaces/:wsId/categories - Create Category', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .post('/workspaces/ws-1/categories')
        .send({ name: 'Dev Team' });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Chưa đăng nhập!');
    });

    it('should return 400 if no name provided', async () => {
      const res = await request(app)
        .post('/workspaces/ws-1/categories')
        .set('x-user-id', 'admin-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Tên category là bắt buộc!');
    });

    it('should create category successfully', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channelCategory.findUnique.mockResolvedValue(null);
      mockPrisma.channelCategory.findFirst.mockResolvedValue({ position: 0 });
      mockPrisma.channelCategory.create.mockResolvedValue({
        id: 'cat-1',
        name: 'Dev Team',
        workspaceId: 'ws-1',
        position: 1,
      });

      const res = await request(app)
        .post('/workspaces/ws-1/categories')
        .set('x-user-id', 'admin-1')
        .send({ name: 'Dev Team' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.category.name).toBe('Dev Team');
    });
  });

  // ==================== LIST CATEGORIES ====================
  describe('GET /workspaces/:wsId/categories - List Categories', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).get('/workspaces/ws-1/categories');
      expect(res.status).toBe(401);
    });

    it('should list categories in workspace', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
      mockPrisma.channelCategory.findMany.mockResolvedValue([
        { id: 'cat-1', name: 'Dev Team', position: 0, channels: [] },
        { id: 'cat-2', name: 'Marketing', position: 1, channels: [] },
      ]);

      const res = await request(app)
        .get('/workspaces/ws-1/categories')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== UPDATE CATEGORY ====================
  describe('PUT /categories/:id - Update Category', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .put('/categories/cat-1')
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(401);
    });

    it('should update category successfully', async () => {
      mockPrisma.channelCategory.findUnique.mockResolvedValue({
        id: 'cat-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channelCategory.update.mockResolvedValue({
        id: 'cat-1',
        name: 'Updated Name',
      });

      const res = await request(app)
        .put('/categories/cat-1')
        .set('x-user-id', 'admin-1')
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== DELETE CATEGORY ====================
  describe('DELETE /categories/:id - Delete Category', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app).delete('/categories/cat-1');
      expect(res.status).toBe(401);
    });

    it('should delete category and unassign channels', async () => {
      mockPrisma.channelCategory.findUnique.mockResolvedValue({
        id: 'cat-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channel.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.channelCategory.delete.mockResolvedValue({});

      const res = await request(app)
        .delete('/categories/cat-1')
        .set('x-user-id', 'admin-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== REORDER CATEGORIES ====================
  describe('PUT /workspaces/:wsId/categories/reorder - Reorder Categories', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .put('/workspaces/ws-1/categories/reorder')
        .send({ categoryIds: ['cat-1', 'cat-2'] });

      expect(res.status).toBe(401);
    });

    it('should return 400 if no categoryIds provided', async () => {
      const res = await request(app)
        .put('/workspaces/ws-1/categories/reorder')
        .set('x-user-id', 'admin-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('categoryIds là bắt buộc!');
    });

    it('should reorder categories successfully', async () => {
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channelCategory.update.mockResolvedValue({});

      const res = await request(app)
        .put('/workspaces/ws-1/categories/reorder')
        .set('x-user-id', 'admin-1')
        .send({ categoryIds: ['cat-2', 'cat-1'] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================== MOVE CHANNEL TO CATEGORY ====================
  describe('PUT /channels/:channelId/category - Move Channel to Category', () => {
    it('should return 401 if no x-user-id header', async () => {
      const res = await request(app)
        .put('/channels/ch-1/category')
        .send({ categoryId: 'cat-1' });

      expect(res.status).toBe(401);
    });

    it('should move channel to category', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channelCategory.findUnique.mockResolvedValue({
        id: 'cat-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.channel.update.mockResolvedValue({
        id: 'ch-1',
        categoryId: 'cat-1',
      });

      const res = await request(app)
        .put('/channels/ch-1/category')
        .set('x-user-id', 'admin-1')
        .send({ categoryId: 'cat-1' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should remove channel from category (null categoryId)', async () => {
      mockPrisma.channel.findUnique.mockResolvedValue({
        id: 'ch-1',
        workspaceId: 'ws-1',
      });
      mockPrisma.workspaceMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.channel.update.mockResolvedValue({
        id: 'ch-1',
        categoryId: null,
      });

      const res = await request(app)
        .put('/channels/ch-1/category')
        .set('x-user-id', 'admin-1')
        .send({ categoryId: null });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Đã bỏ channel khỏi category!');
    });
  });
});
