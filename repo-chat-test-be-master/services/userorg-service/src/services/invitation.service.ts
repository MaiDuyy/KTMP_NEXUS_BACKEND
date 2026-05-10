// services/userorg-service/src/services/invitation.service.ts
// USER-07: User Invitation, USER-10: Guest Invitation

import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import type { InvitationType } from '@prisma/client';

// Email queue publisher (RabbitMQ)
// Will be imported from shared package when available
interface EmailJobPayload {
  to: string;
  template: string;
  data: Record<string, unknown>;
}

// Type for invitation with computed status
interface InvitationWithStatus {
  id: string;
  email: string;
  token: string;
  type: InvitationType;
  channelIds: string[];
  workspaceId: string | null;
  invitedBy: string;
  inviterName: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
}

export class InvitationService {
  private readonly tokenLength = 32;
  private readonly defaultExpiryDays = 7;

  /**
   * Generate secure invitation token
   */
  private generateToken(): string {
    return crypto.randomBytes(this.tokenLength).toString('hex');
  }

  /**
   * Calculate invitation status
   */
  private getInvitationStatus(invitation: {
    acceptedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  }): 'pending' | 'accepted' | 'expired' | 'revoked' {
    if (invitation.acceptedAt) return 'accepted';
    if (invitation.revokedAt) return 'revoked';
    if (new Date() > invitation.expiresAt) return 'expired';
    return 'pending';
  }

  /**
   * Create a new invitation (USER-07: User, USER-10: Guest)
   */
  async createInvitation(data: {
    email: string;
    type: InvitationType;
    invitedBy: string;
    inviterName: string;
    channelIds?: string[];
    workspaceId?: string;
    expiryDays?: number;
  }): Promise<InvitationWithStatus> {
    const { email, type, invitedBy, inviterName, channelIds = [], workspaceId, expiryDays = this.defaultExpiryDays } = data;

    // Check if email already has pending invitation
    const existingInvitation = await prisma.invitation.findFirst({
      where: {
        email: email.toLowerCase(),
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (existingInvitation) {
      throw new Error('Email đã có lời mời đang chờ xử lý!');
    }

    // Check if user already exists
    const existingUser = await prisma.account.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      throw new Error('Email đã được đăng ký trong hệ thống!');
    }

    // Validate guest invitation has channels
    if (type === 'GUEST' && channelIds.length === 0) {
      throw new Error('Guest invitation phải có ít nhất 1 channel!');
    }

    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    const invitation = await prisma.invitation.create({
      data: {
        email: email.toLowerCase(),
        token,
        type,
        channelIds,
        workspaceId,
        invitedBy,
        inviterName,
        expiresAt,
      },
    });

    logger.info({ email, type, invitedBy }, 'Invitation created');

    // Publish event for email sending (will be consumed by job-worker)
    await this.sendInvitationEmail(invitation, inviterName);

    // Publish NATS event
    await publishEvent(EventSubjects.INVITATION_CREATED || 'invitation.created', {
      invitationId: invitation.id,
      email: invitation.email,
      type: invitation.type,
      invitedBy,
      timestamp: new Date().toISOString(),
    });

    return {
      ...invitation,
      status: 'pending',
    };
  }

  /**
   * Send invitation email via RabbitMQ queue
   */
  private async sendInvitationEmail(invitation: {
    email: string;
    token: string;
    type: InvitationType;
    expiresAt: Date;
  }, inviterName: string): Promise<void> {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviteUrl = `${baseUrl}/invite/${invitation.token}`;

    const emailPayload: EmailJobPayload = {
      to: invitation.email,
      template: 'invitation',
      data: {
        inviteUrl,
        inviterName,
        orgName: process.env.ORG_NAME || 'Our Company',
        expiresAt: invitation.expiresAt.toISOString(),
        type: invitation.type,
      },
    };

    // TODO: Publish to RabbitMQ queue 'q.email.send'
    // For now, just log it
    logger.info({ emailPayload }, 'Email job queued');

    // When RabbitMQ client is available:
    // await rabbitmqClient.publish('q.email.send', emailPayload);
  }

  /**
   * Validate invitation token
   */
  async validateToken(token: string): Promise<InvitationWithStatus | null> {
    const invitation = await prisma.invitation.findUnique({
      where: { token },
    });

    if (!invitation) {
      return null;
    }

    return {
      ...invitation,
      status: this.getInvitationStatus(invitation),
    };
  }

  /**
   * Accept invitation and create user account
   */
  async acceptInvitation(token: string, userData: {
    name: string;
    password: string;
    gender?: string;
  }): Promise<{ userId: string; email: string; type: InvitationType }> {
    const invitation = await prisma.invitation.findUnique({
      where: { token },
    });

    if (!invitation) {
      throw new Error('Lời mời không hợp lệ!');
    }

    if (invitation.acceptedAt) {
      throw new Error('Lời mời đã được sử dụng!');
    }

    if (invitation.revokedAt) {
      throw new Error('Lời mời đã bị thu hồi!');
    }

    if (new Date() > invitation.expiresAt) {
      throw new Error('Lời mời đã hết hạn!');
    }

    // Mark invitation as accepted
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    logger.info({ email: invitation.email, type: invitation.type }, 'Invitation accepted');

    // Publish event for auth-service to create user
    await publishEvent(EventSubjects.INVITATION_ACCEPTED || 'invitation.accepted', {
      invitationId: invitation.id,
      email: invitation.email,
      name: userData.name,
      password: userData.password,
      gender: userData.gender || 'other',
      type: invitation.type,
      channelIds: invitation.channelIds,
      workspaceId: invitation.workspaceId,
      timestamp: new Date().toISOString(),
    });

    return {
      userId: invitation.id, // Will be replaced by actual userId after auth-service creates user
      email: invitation.email,
      type: invitation.type,
    };
  }

  /**
   * List invitations (Admin)
   */
  async listInvitations(filters: {
    status?: 'pending' | 'accepted' | 'expired' | 'revoked';
    type?: InvitationType;
    page?: number;
    limit?: number;
  }): Promise<{ invitations: InvitationWithStatus[]; total: number }> {
    const { status, type, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (type) {
      where.type = type;
    }

    // Status filtering
    if (status === 'pending') {
      where.acceptedAt = null;
      where.revokedAt = null;
      where.expiresAt = { gt: new Date() };
    } else if (status === 'accepted') {
      where.acceptedAt = { not: null };
    } else if (status === 'revoked') {
      where.revokedAt = { not: null };
    } else if (status === 'expired') {
      where.acceptedAt = null;
      where.revokedAt = null;
      where.expiresAt = { lte: new Date() };
    }

    const [invitations, total] = await Promise.all([
      prisma.invitation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.invitation.count({ where }),
    ]);

    return {
      invitations: invitations.map(inv => ({
        ...inv,
        status: this.getInvitationStatus(inv),
      })),
      total,
    };
  }

  /**
   * Revoke invitation
   */
  async revokeInvitation(invitationId: string, revokedBy: string): Promise<void> {
    const invitation = await prisma.invitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new Error('Không tìm thấy lời mời!');
    }

    if (invitation.acceptedAt) {
      throw new Error('Không thể thu hồi lời mời đã được chấp nhận!');
    }

    await prisma.invitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() },
    });

    logger.info({ invitationId, revokedBy }, 'Invitation revoked');
  }

  /**
   * Resend invitation email
   */
  async resendInvitation(invitationId: string): Promise<void> {
    const invitation = await prisma.invitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new Error('Không tìm thấy lời mời!');
    }

    const status = this.getInvitationStatus(invitation);
    if (status !== 'pending') {
      throw new Error(`Không thể gửi lại lời mời với trạng thái: ${status}`);
    }

    await this.sendInvitationEmail(invitation, invitation.inviterName || 'Admin');
    logger.info({ invitationId }, 'Invitation resent');
  }
}

export const invitationService = new InvitationService();
