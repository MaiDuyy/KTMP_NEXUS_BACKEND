// services/identity-service/src/services/org-settings.service.ts
// Migrated from userorg-service — prisma → userorgPrisma

import { userorgPrisma } from '../lib/prisma.js';
import { publishEvent } from '../lib/nats.js';
import { logger } from '../lib/logger.js';

export interface UpdateOrgSettingsDto {
  companyName?: string; logoUrl?: string | null; timezone?: string; language?: string;
  allowGuestInvite?: boolean; allowUserInvite?: boolean; defaultUserRole?: string;
  messageRetentionDays?: number; fileRetentionDays?: number;
}

const MAIN_SETTINGS_ID = 'main';

export class OrgSettingsService {
  async getSettings() {
    let settings = await userorgPrisma.orgSettings.findUnique({ where: { id: MAIN_SETTINGS_ID } });
    if (!settings) {
      settings = await userorgPrisma.orgSettings.create({
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

  async updateSettings(data: UpdateOrgSettingsDto, updatedBy: string) {
    if (data.companyName !== undefined && (!data.companyName || data.companyName.trim().length < 2))
      throw new Error('Tên công ty phải có ít nhất 2 ký tự!');
    if (data.timezone !== undefined) {
      try { Intl.DateTimeFormat(undefined, { timeZone: data.timezone }); }
      catch { throw new Error('Timezone không hợp lệ!'); }
    }
    if (data.language !== undefined) {
      const validLanguages = ['en', 'vi', 'zh', 'ja', 'ko', 'th'];
      if (!validLanguages.includes(data.language)) throw new Error('Ngôn ngữ không được hỗ trợ!');
    }
    if (data.defaultUserRole !== undefined) {
      const validRoles = ['WORKSPACE_MEMBER', 'WORKSPACE_GUEST'];
      if (!validRoles.includes(data.defaultUserRole)) throw new Error('Role mặc định không hợp lệ!');
    }
    if (data.messageRetentionDays !== undefined && data.messageRetentionDays < 0) throw new Error('Thời gian lưu trữ không thể âm!');
    if (data.fileRetentionDays !== undefined && data.fileRetentionDays < 0) throw new Error('Thời gian lưu trữ không thể âm!');

    await this.getSettings();
    const updateData: Record<string, unknown> = { updatedBy };
    if (data.companyName !== undefined) updateData.companyName = data.companyName.trim();
    if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
    if (data.timezone !== undefined) updateData.timezone = data.timezone;
    if (data.language !== undefined) updateData.language = data.language;
    if (data.allowGuestInvite !== undefined) updateData.allowGuestInvite = data.allowGuestInvite;
    if (data.allowUserInvite !== undefined) updateData.allowUserInvite = data.allowUserInvite;
    if (data.defaultUserRole !== undefined) updateData.defaultUserRole = data.defaultUserRole;
    if (data.messageRetentionDays !== undefined) updateData.messageRetentionDays = data.messageRetentionDays;
    if (data.fileRetentionDays !== undefined) updateData.fileRetentionDays = data.fileRetentionDays;

    const settings = await userorgPrisma.orgSettings.update({ where: { id: MAIN_SETTINGS_ID }, data: updateData });
    logger.info({ updatedBy, changes: Object.keys(data) }, 'Org settings updated');
    await publishEvent('org.settings.updated', { changes: Object.keys(data), updatedBy, timestamp: new Date().toISOString() });
    return settings;
  }

  async isGuestInviteAllowed(): Promise<boolean> { return (await this.getSettings()).allowGuestInvite; }
  async isUserInviteAllowed(): Promise<boolean> { return (await this.getSettings()).allowUserInvite; }
  async getDefaultUserRole(): Promise<string> { return (await this.getSettings()).defaultUserRole; }
  async getCompanyName(): Promise<string> { return (await this.getSettings()).companyName; }
}

export const orgSettingsService = new OrgSettingsService();
