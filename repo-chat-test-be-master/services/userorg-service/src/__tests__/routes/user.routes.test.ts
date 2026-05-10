import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { mockPrisma, mockPublishEvent } from '../setup.js';

// Create test app
const app = express();
app.use(express.json());

// Import routes after mocks are set up
let userRoutes: typeof import('../../routes/user.routes.js').userRoutes;

beforeAll(async () => {
  ({ userRoutes } = await import('../../routes/user.routes.js'));
  app.use('/users', userRoutes);
});

// Error handler for tests
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, message: err.message });
});

describe('User Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /users/profile', () => {
    it('should return 401 without x-user-id header', async () => {
      const response = await request(app).get('/users/profile');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should return profile with valid auth', async () => {
      const mockProfile = {
        id: 'user-1',
        name: 'Test User',
        email: 'test@test.com',
        avatar: null,
        status: null,
      };
      mockPrisma.account.findUnique.mockResolvedValue(mockProfile);

      const response = await request(app)
        .get('/users/profile')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.name).toBe('Test User');
    });
  });

  describe('PUT /users/profile', () => {
    it('should return 401 without auth', async () => {
      const response = await request(app)
        .put('/users/profile')
        .send({ name: 'New Name' });

      expect(response.status).toBe(401);
    });

    it('should update profile with valid auth', async () => {
      mockPrisma.account.update.mockResolvedValue({
        id: 'user-1',
        name: 'Updated Name',
      });

      const response = await request(app)
        .put('/users/profile')
        .set('x-user-id', 'user-1')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('PUT /users/status', () => {
    it('should update status text', async () => {
      mockPrisma.account.update.mockResolvedValue({
        id: 'user-1',
        status: 'Busy working',
      });

      const response = await request(app)
        .put('/users/status')
        .set('x-user-id', 'user-1')
        .send({ status: 'Busy working' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should validate status length', async () => {
      const response = await request(app)
        .put('/users/status')
        .set('x-user-id', 'user-1')
        .send({ status: 'a'.repeat(300) });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /users/:id', () => {
    it('should return user by id', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'user-2',
        name: 'Other User',
        email: 'other@test.com',
      });

      const response = await request(app)
        .get('/users/user-2');

      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe('user-2');
    });
  });

  describe('GET /users (admin list)', () => {
    it('should return paginated users', async () => {
      const mockUsers = [
        { id: 'user-1', name: 'User 1' },
        { id: 'user-2', name: 'User 2' },
      ];
      mockPrisma.account.findMany.mockResolvedValue(mockUsers );
      mockPrisma.account.count.mockResolvedValue(2);

      const response = await request(app)
        .get('/users')
        .query({ page: 1, limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body.users.length).toBe(2);
      expect(response.body.pagination.total).toBe(2);
    });
  });

  describe('POST /users/:id/suspend', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .post('/users/user-2/suspend')
        .send({ reason: 'Violation of terms' });

      expect(response.status).toBe(401);
    });

    it('should suspend user with valid reason', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'user-2',
        isSuspended: false,
      });
      mockPrisma.account.update.mockResolvedValue({
        id: 'user-2',
        isSuspended: true,
      });

      const response = await request(app)
        .post('/users/user-2/suspend')
        .set('x-user-id', 'admin-1')
        .send({ reason: 'Violation of terms of service' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});
