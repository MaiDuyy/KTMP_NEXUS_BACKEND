import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockPrisma, mockPublishEvent } from '../setup.js';

let orgSettingsService: typeof import('../../services/org-settings.service.js').orgSettingsService;

beforeAll(async () => {
  ({ orgSettingsService } = await import('../../services/org-settings.service.js'));
});

describe('OrgSettingsService', () => {
  beforeEach(() => {
    mockPrisma.orgSettings.findUnique.mockReset();
    mockPrisma.orgSettings.create.mockReset();
    mockPrisma.orgSettings.update.mockReset();
    mockPublishEvent.mockReset();
  });

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

  describe('getSettings', () => {
    it('should return existing settings', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      const result = await orgSettingsService.getSettings();

      expect(result).toEqual(defaultSettings);
      expect(mockPrisma.orgSettings.findUnique).toHaveBeenCalledWith({
        where: { id: 'main' },
      });
    });

    it('should create default settings if none exist', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(null);
      mockPrisma.orgSettings.create.mockResolvedValue(defaultSettings);

      const result = await orgSettingsService.getSettings();

      expect(result).toEqual(defaultSettings);
      expect(mockPrisma.orgSettings.create).toHaveBeenCalled();
    });
  });

  describe('updateSettings', () => {
    it('should update settings and publish event', async () => {
      const updatedSettings = {
        ...defaultSettings,
        companyName: 'New Company Name',
      };

      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);
      mockPrisma.orgSettings.update.mockResolvedValue(updatedSettings);

      const result = await orgSettingsService.updateSettings(
        { companyName: 'New Company Name' },
        'admin-1'
      );

      expect(result.companyName).toBe('New Company Name');
      expect(mockPublishEvent).toHaveBeenCalled();
    });

    it('should validate company name minimum length', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      await expect(
        orgSettingsService.updateSettings({ companyName: 'A' }, 'admin-1')
      ).rejects.toThrow('Tên công ty phải có ít nhất 2 ký tự!');
    });

    it('should validate timezone', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      await expect(
        orgSettingsService.updateSettings({ timezone: 'Invalid/Zone' }, 'admin-1')
      ).rejects.toThrow('Timezone không hợp lệ!');
    });

    it('should validate language', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      await expect(
        orgSettingsService.updateSettings({ language: 'invalid' }, 'admin-1')
      ).rejects.toThrow('Ngôn ngữ không được hỗ trợ!');
    });

    it('should validate retention days non-negative', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      await expect(
        orgSettingsService.updateSettings({ messageRetentionDays: -1 }, 'admin-1')
      ).rejects.toThrow('Thời gian lưu trữ không thể âm!');
    });
  });

  describe('isGuestInviteAllowed', () => {
    it('should return true when guest invite allowed', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue({
        ...defaultSettings,
        allowGuestInvite: true,
      });

      const result = await orgSettingsService.isGuestInviteAllowed();

      expect(result).toBe(true);
    });

    it('should return false when guest invite disabled', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue({
        ...defaultSettings,
        allowGuestInvite: false,
      });

      const result = await orgSettingsService.isGuestInviteAllowed();

      expect(result).toBe(false);
    });
  });

  describe('getCompanyName', () => {
    it('should return company name', async () => {
      mockPrisma.orgSettings.findUnique.mockResolvedValue(defaultSettings);

      const result = await orgSettingsService.getCompanyName();

      expect(result).toBe('Test Company');
    });
  });
});
