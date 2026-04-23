// services/userorg-service/src/services/org-settings.service.ts
// USER-12: Organization Settings (Single-org)

import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export interface OrgSettings {
  id: string;
  companyName: string;
  logoUrl: string | null;
  timezone: string;
  language: string;
  allowGuestInvite: boolean;
  allowUserInvite: boolean;
  defaultUserRole: string;
  messageRetentionDays: number;
  fileRetentionDays: number;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface UpdateOrgSettingsDto {
  companyName?: string;
  logoUrl?: string | null;
  timezone?: string;
  language?: string;
  allowGuestInvite?: boolean;
  allowUserInvite?: boolean;
  defaultUserRole?: string;
  messageRetentionDays?: number;
  fileRetentionDays?: number;
}

// Singleton ID for single-org
const MAIN_SETTINGS_ID = 'main';

export class OrgSettingsService {
  /**
   * Get organization settings (singleton pattern)
   * Creates default settings if not exists
   */
  async getSettings(): Promise<OrgSettings> {
    let settings = await prisma.orgSettings.findUnique({
      where: { id: MAIN_SETTINGS_ID },
    });

    // Create default settings if not exists
    if (!settings) {
      settings = await prisma.orgSettings.create({
        data: {
          id: MAIN_SETTINGS_ID,
          companyName: process.env.DEFAULT_COMPANY_NAME || 'My Company',
          timezone: process.env.DEFAULT_TIMEZONE || 'UTC',
          language: process.env.DEFAULT_LANGUAGE || 'en',
        },
      });
      logger.info('Created default org settings');
    }

    return settings;
  }

  /**
   * Update organization settings (Super Admin only)
   */
  async updateSettings(
    data: UpdateOrgSettingsDto,
    updatedBy: string
  ): Promise<OrgSettings> {
    // Validate inputs
    if (data.companyName !== undefined) {
      if (!data.companyName || data.companyName.trim().length < 2) {
        throw new Error('Tên công ty phải có ít nhất 2 ký tự!');
      }
    }

    if (data.timezone !== undefined) {
      // Basic timezone validation
      const validTimezones = [
        'UTC', 
        'Asia/Ho_Chi_Minh', 
        'Asia/Bangkok', 
        'America/New_York',
        'America/Los_Angeles',
        'Europe/London',
        'Europe/Paris',
        'Asia/Tokyo',
        'Asia/Singapore',
      ];
      if (!validTimezones.includes(data.timezone)) {
        // Allow any Intl timezone
        try {
          Intl.DateTimeFormat(undefined, { timeZone: data.timezone });
        } catch {
          throw new Error('Timezone không hợp lệ!');
        }
      }
    }

    if (data.language !== undefined) {
      const validLanguages = ['en', 'vi', 'zh', 'ja', 'ko', 'th'];
      if (!validLanguages.includes(data.language)) {
        throw new Error('Ngôn ngữ không được hỗ trợ!');
      }
    }

    if (data.defaultUserRole !== undefined) {
      const validRoles = ['EMPLOYEE', 'GUEST'];
      if (!validRoles.includes(data.defaultUserRole)) {
        throw new Error('Role mặc định không hợp lệ!');
      }
    }

    if (data.messageRetentionDays !== undefined) {
      if (data.messageRetentionDays < 0) {
        throw new Error('Thời gian lưu trữ không thể âm!');
      }
    }

    if (data.fileRetentionDays !== undefined) {
      if (data.fileRetentionDays < 0) {
        throw new Error('Thời gian lưu trữ không thể âm!');
      }
    }

    // Ensure settings exist
    await this.getSettings();

    // Build update data
    const updateData: Record<string, unknown> = {
      updatedBy,
    };

    if (data.companyName !== undefined) updateData.companyName = data.companyName.trim();
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
    if (data.timezone !== undefined) updateData.timezone = data.timezone;
    if (data.language !== undefined) updateData.language = data.language;
    if (data.allowGuestInvite !== undefined) updateData.allowGuestInvite = data.allowGuestInvite;
    if (data.allowUserInvite !== undefined) updateData.allowUserInvite = data.allowUserInvite;
    if (data.defaultUserRole !== undefined) updateData.defaultUserRole = data.defaultUserRole;
    if (data.messageRetentionDays !== undefined) updateData.messageRetentionDays = data.messageRetentionDays;
    if (data.fileRetentionDays !== undefined) updateData.fileRetentionDays = data.fileRetentionDays;

    const settings = await prisma.orgSettings.update({
      where: { id: MAIN_SETTINGS_ID },
      data: updateData,
    });

    logger.info({ updatedBy, changes: Object.keys(data) }, 'Org settings updated');

    // Publish event
    await publishEvent(EventSubjects.ORG_SETTINGS_UPDATED || 'org.settings.updated', {
      changes: Object.keys(data),
      updatedBy,
      timestamp: new Date().toISOString(),
    });

    return settings;
  }

  /**
   * Check if guest invitations are allowed
   */
  async isGuestInviteAllowed(): Promise<boolean> {
    const settings = await this.getSettings();
    return settings.allowGuestInvite;
  }

  /**
   * Check if user invitations are allowed
   */
  async isUserInviteAllowed(): Promise<boolean> {
    const settings = await this.getSettings();
    return settings.allowUserInvite;
  }

  /**
   * Get default user role for new users
   */
  async getDefaultUserRole(): Promise<string> {
    const settings = await this.getSettings();
    return settings.defaultUserRole;
  }

  /**
   * Get company name for emails and UI
   */
  async getCompanyName(): Promise<string> {
    const settings = await this.getSettings();
    return settings.companyName;
  }
}

export const orgSettingsService = new OrgSettingsService();
