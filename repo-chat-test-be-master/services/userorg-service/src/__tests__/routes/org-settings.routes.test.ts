import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { mockPrisma, mockPublishEvent } from '../setup.js';

// Create test app
const app = express();
app.use(express.json());

// Import routes after mocks
let orgSettingsRoutes: typeof import('../../routes/org-settings.routes.js').orgSettingsRoutes;

beforeAll(async () => {
  ({ orgSettingsRoutes } = await import('../../routes/org-settings.routes.js'));
  app.use('/org-settings', orgSettingsRoutes);
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, message: err.message });
});

describe('Org Settings Routes', () => {
  const defaultSettings = {
    id: 'main',
    companyName: 'Test Company',
    logoUrl: null,
    timezone: 'UTC',
    language: 'en',
    allowGuestInvite: true,
    allowUserInvite: true,
    defaultUserRole: 'EMPLOYEE',
    messageRetentionDays: 365,
    fileRetentionDays: 365,
    updatedAt: new Date(),
    updatedBy: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /org-settings', () => {
    it('should require auth', async () => {
      const response = await request(app).get('/org-settings');

      expect(response.status).toBe(401);
    });

    it('should return settings with auth', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      const response = await request(app)
        .get('/org-settings')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.settings.companyName).toBe('Test Company');
    });
  });

  describe('PUT /org-settings', () => {
    it('should require auth', async () => {
      const response = await request(app)
        .put('/org-settings')
        .send({ companyName: 'New Company' });

      expect(response.status).toBe(401);
    });

    it('should update settings with valid data', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);
      mockPrisma.orgSettings.update.mockResolvedValue({
        ...defaultSettings,
        companyName: 'Updated Company',
      });

      const response = await request(app)
        .put('/org-settings')
        .set('x-user-id', 'admin-1')
        .send({ companyName: 'Updated Company' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.settings.companyName).toBe('Updated Company');
    });

    it('should validate company name length', async () => {
      // Service throws validation error for names < 2 chars
      const response = await request(app)
        .put('/org-settings')
        .set('x-user-id', 'admin-1')
        .send({ companyName: 'A' });

      // Validation error in service causes 500
      expect(response.status).toBe(500);
    });
  });

  describe('GET /org-settings/company-name', () => {
    it('should return company name (public endpoint)', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      const response = await request(app)
        .get('/org-settings/company-name');

      expect(response.status).toBe(200);
      expect(response.body.companyName).toBe('Test Company');
    });
  });

  describe('GET /org-settings/invite-settings', () => {
    it('should return invite settings (public endpoint)', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      const response = await request(app)
        .get('/org-settings/invite-settings');

      expect(response.status).toBe(200);
      expect(response.body.allowGuestInvite).toBe(true);
      expect(response.body.allowUserInvite).toBe(true);
      expect(response.body.defaultUserRole).toBe('EMPLOYEE');
    });
  });
});
