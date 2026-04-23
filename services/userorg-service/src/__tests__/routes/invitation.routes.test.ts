import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { mockPrisma, mockPublishEvent } from '../setup.js';

// Create test app
const app = express();
app.use(express.json());

// Import routes after mocks
let invitationRoutes: typeof import('../../routes/invitation.routes.js').invitationRoutes;

beforeAll(async () => {
  ({ invitationRoutes } = await import('../../routes/invitation.routes.js'));
  app.use('/invitations', invitationRoutes);
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, message: err.message });
});

describe('Invitation Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /invitations/validate/:token', () => {
    it('should return invitation for valid token', async () => {
      const mockInvitation = {
        id: 'inv-1',
        email: 'new@test.com',
        token: 'valid-token',
        type: 'USER',
        inviterName: 'Admin',
        expiresAt: new Date(Date.now() + 86400000),
        acceptedAt: null,
        revokedAt: null,
      };
      mockPrisma.invitation.findUnique.mockResolvedValue(mockInvitation);

      const response = await request(app)
        .get('/invitations/validate/valid-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.invitation.email).toBe('new@test.com');
    });

    it('should return 404 for invalid token', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .get('/invitations/validate/invalid-token');

      expect(response.status).toBe(404);
    });

    it('should return 400 for expired token', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        expiresAt: new Date(Date.now() - 86400000), // Yesterday
        acceptedAt: null,
        revokedAt: null,
      });

      const response = await request(app)
        .get('/invitations/validate/expired-token');

      expect(response.status).toBe(400);
    });
  });

  describe('POST /invitations/accept/:token', () => {
    it('should require name and password', async () => {
      const response = await request(app)
        .post('/invitations/accept/valid-token')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('tên và mật khẩu');
    });

    it('should require password min length', async () => {
      const response = await request(app)
        .post('/invitations/accept/valid-token')
        .send({ name: 'Test User', password: '123' });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('6 ký tự');
    });
  });

  describe('POST /invitations (create)', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .post('/invitations')
        .send({ email: 'new@test.com', type: 'USER' });

      expect(response.status).toBe(401);
    });

    it('should require email', async () => {
      const response = await request(app)
        .post('/invitations')
        .set('x-user-id', 'admin-1')
        .send({ type: 'USER' });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Email');
    });

    it('should create invitation with valid data', async () => {
      // Mock org settings check
      mockPrisma.orgSettings.findUnique.mockResolvedValue({
        id: 'main',
        allowUserInvite: true,
        allowGuestInvite: true,
      });
      
      // Mock no existing pending invitation
      mockPrisma.invitation.findFirst.mockResolvedValue(null);
      // Mock no existing user with this email
      mockPrisma.account.findUnique.mockResolvedValue(null);
      
      mockPrisma.invitation.create.mockResolvedValue({
        id: 'inv-1',
        email: 'new@test.com',
        token: 'generated-token',
        type: 'USER',
        channelIds: [],
        workspaceId: null,
        invitedBy: 'admin-1',
        inviterName: 'Admin User',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date(),
      });

      const response = await request(app)
        .post('/invitations')
        .set('x-user-id', 'admin-1')
        .set('x-user-name', 'Admin User')
        .send({ email: 'new@test.com', type: 'USER' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /invitations (list)', () => {
    it('should require auth', async () => {
      const response = await request(app).get('/invitations');

      expect(response.status).toBe(401);
    });

    it('should return paginated invitations', async () => {
      const mockInvitations = [
        { id: 'inv-1', email: 'user1@test.com' },
        { id: 'inv-2', email: 'user2@test.com' },
      ];
      mockPrisma.invitation.findMany.mockResolvedValue(mockInvitations);
      mockPrisma.invitation.count.mockResolvedValue(2);

      const response = await request(app)
        .get('/invitations')
        .set('x-user-id', 'admin-1');

      expect(response.status).toBe(200);
      expect(response.body.invitations.length).toBe(2);
    });
  });

  describe('DELETE /invitations/:id', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .delete('/invitations/inv-1');

      expect(response.status).toBe(401);
    });

    it('should revoke invitation', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockPrisma.invitation.update.mockResolvedValue({
        id: 'inv-1',
        revokedAt: new Date(),
      });

      const response = await request(app)
        .delete('/invitations/inv-1')
        .set('x-user-id', 'admin-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});
