// services/identity-service/src/services/invitation.service.ts
// Migrated from userorg-service — prisma → userorgPrisma

import crypto from 'crypto';
import { userorgPrisma } from '../lib/prisma.js';
import { publishEvent, EventSubjects } from '../lib/nats.js';
import { logger } from '../lib/logger.js';
import { messagingGrpc } from '../lib/messagingClient.js';

interface EmailJobPayload {
  to: string;
  template: string;
  data: Record<string, unknown>;
}

type InvitationType = 'USER' | 'GUEST' | 'MANAGER';

interface InvitationWithStatus {
  id: string; email: string; token: string; type: InvitationType;
  channelIds: string[]; workspaceId: string | null;
  orgId: string | null;
  role: string | null;
  invitedBy: string; inviterName: string | null;
  expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; createdAt: Date;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
}

export class InvitationService {
  private readonly tokenLength = 32;
  private readonly defaultExpiryDays = 7;

  private generateToken(): string { return crypto.randomBytes(this.tokenLength).toString('hex'); }

  private getInvitationStatus(invitation: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date; }): 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED' {
    if (invitation.acceptedAt) return 'ACCEPTED';
    if (invitation.revokedAt) return 'REVOKED';
    if (new Date() > invitation.expiresAt) return 'EXPIRED';
    return 'PENDING';
  }

  async createInvitation(data: {
    email: string; type: InvitationType; invitedBy: string; inviterName: string;
    role?: string; channelIds?: string[]; workspaceId?: string; expiryDays?: number;
  }): Promise<InvitationWithStatus> {
    const { email, type, invitedBy, inviterName, role, channelIds = [], workspaceId, expiryDays = this.defaultExpiryDays } = data;

    const existingInvitation = await userorgPrisma.invitation.findFirst({
      where: { email: email.toLowerCase(), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (existingInvitation) throw new Error('Email đã có lời mời đang chờ xử lý!');

    // Remove check for existing user to allow inviting existing accounts
    // const existingUser = await userorgPrisma.account.findUnique({ where: { email: email.toLowerCase() } });
    // if (existingUser) throw new Error('Email đã được đăng ký trong hệ thống!');

    if (type === 'GUEST' && channelIds.length === 0) throw new Error('Guest invitation phải có ít nhất 1 channel!');

    // Get inviter's orgId
    const inviter = await userorgPrisma.account.findUnique({ where: { id: invitedBy }, select: { orgId: true } });
    const orgId = inviter?.orgId;

    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    const invitation = await userorgPrisma.invitation.create({
      data: { email: email.toLowerCase(), token, type, role: role || 'EMPLOYEE', channelIds, workspaceId, orgId, invitedBy, inviterName, expiresAt },
    });

    logger.info({ email, type, invitedBy }, 'Invitation created');
    
    // Check if user already exists to send real-time notification
    const existingUser = await userorgPrisma.account.findUnique({ 
      where: { email: email.toLowerCase() },
      select: { id: true }
    });

    // Fetch workspace name if applicable
    let workspaceName = 'Workspace';
    if (workspaceId) {
      try {
        const wsMeta = await messagingGrpc.getWorkspaceMetadata(workspaceId);
        if (wsMeta && wsMeta.name) workspaceName = wsMeta.name;
      } catch (err) {
        logger.warn({ workspaceId }, 'Could not fetch workspace name for notification');
      }
    }

    await this.sendInvitationEmail(invitation, inviterName);

    // Publish event for real-time notification
    await publishEvent(EventSubjects.WORKSPACE_INVITE_CREATED, {
      invitationId: invitation.id,
      email: invitation.email,
      type: invitation.type,
      invitedBy,
      inviterName,
      inviteeId: existingUser?.id, // If user exists, they get a real-time notification
      workspaceId,
      workspaceName,
      token,
      role: invitation.role,
      timestamp: new Date().toISOString(),
    });

    return { ...invitation, status: 'pending' };
  }

  private async sendInvitationEmail(invitation: { email: string; token: string; type: string; expiresAt: Date; }, inviterName: string): Promise<void> {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviteUrl = `${baseUrl}/invite?token=${invitation.token}`;
    const emailPayload: EmailJobPayload = {
      to: invitation.email, template: 'invitation',
      data: { 
        inviteUrl, 
        inviterName, 
        orgName: process.env.ORG_NAME || 'Our Company', 
        expiresAt: invitation.expiresAt.toISOString(), 
        type: invitation.type 
      },
    };
    
    // Publish to notification-service
    await publishEvent('invitation.send', emailPayload);
    logger.info({ email: invitation.email }, 'Invitation email event published');
  }

  async validateInvitationToken(token: string): Promise<any | null> {
    const invitation = await userorgPrisma.invitation.findUnique({ where: { token } });
    if (!invitation) return null;
    
    let workspace = null;
    if (invitation.workspaceId) {
      try {
        workspace = await messagingGrpc.getWorkspaceMetadata(invitation.workspaceId);
      } catch (error) {
        logger.warn({ workspaceId: invitation.workspaceId }, 'Failed to fetch workspace metadata via gRPC');
      }
    }

    return { 
      ...invitation, 
      status: this.getInvitationStatus(invitation),
      workspace
    };
  }

  async acceptInvitation(token: string, userData: { name: string; password: string; gender?: string; }): Promise<any> {
    const invitation = await userorgPrisma.invitation.findUnique({ where: { token } });
    if (!invitation) throw new Error('Lời mời không hợp lệ!');
    if (invitation.acceptedAt) throw new Error('Lời mời đã được sử dụng!');
    if (invitation.revokedAt) throw new Error('Lời mời đã bị thu hồi!');
    if (new Date() > invitation.expiresAt) throw new Error('Lời mời đã hết hạn!');

    await userorgPrisma.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
    logger.info({ email: invitation.email, type: invitation.type }, 'Invitation accepted');

    // Import authService dynamically to avoid circular dependency
    const { authService } = await import('./auth.service.js');
    
    // Create account synchronously and get tokens
    const result = await authService.createAccountFromInvitation({
      email: invitation.email,
      name: userData.name,
      password: userData.password,
      gender: userData.gender,
      role: invitation.role || undefined,
      workspaceId: invitation.workspaceId || undefined,
      orgId: invitation.orgId || undefined,
      channelIds: invitation.channelIds,
      type: invitation.type,
      invitedBy: invitation.invitedBy,
    });

    return result;
  }

  async joinViaInvitation(token: string, userId: string): Promise<void> {
    const invitation = await userorgPrisma.invitation.findUnique({ where: { token } });
    if (!invitation) throw new Error('Lời mời không hợp lệ!');
    if (invitation.acceptedAt) throw new Error('Lời mời đã được sử dụng!');
    if (invitation.revokedAt) throw new Error('Lời mời đã bị thu hồi!');
    if (new Date() > invitation.expiresAt) throw new Error('Lời mời đã hết hạn!');

    const user = await userorgPrisma.account.findUnique({ where: { id: userId } });
    if (!user) throw new Error('Người dùng không tồn tại!');
    
    // Check if email matches (security)
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new Error('Lời mời này không dành cho tài khoản của bạn!');
    }

    // 1. Mark invitation as accepted
    await userorgPrisma.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });

    // 2. Update user's OrgId in userorg schema
    await userorgPrisma.account.update({ where: { id: userId }, data: { orgId: invitation.orgId } });

    // 3. Assign Role/Workspace (Sync via gRPC to avoid race condition)
    if (invitation.workspaceId) {
      try {
        const grpcResult = await messagingGrpc.addMember(
          invitation.workspaceId,
          userId,
          invitation.role || 'EMPLOYEE',
          invitation.invitedBy
        );
        if (!grpcResult.success) {
          logger.error({ userId, workspaceId: invitation.workspaceId, message: grpcResult.message }, 'Failed to add member via gRPC in joinViaInvitation');
        }
      } catch (err) {
        logger.error({ err, userId, workspaceId: invitation.workspaceId }, 'gRPC error in joinViaInvitation');
      }
    }

    // 4. Trigger NATS event (Still publish for other services/async tasks)
    await publishEvent('invitation.joined', {
      userId,
      email: invitation.email,
      type: invitation.type,
      role: invitation.role,
      channelIds: invitation.channelIds,
      workspaceId: invitation.workspaceId,
      orgId: invitation.orgId,
      invitedBy: invitation.invitedBy,
      timestamp: new Date().toISOString(),
    });

    logger.info({ userId, orgId: invitation.orgId }, 'User joined via invitation');
  }

  async listInvitations(filters: { status?: string; type?: InvitationType; workspaceId?: string; page?: number; limit?: number; }) {
    const { status, type, workspaceId, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;
    const where: Record<string, unknown> = {};
    if (type) where.type = type;
    if (workspaceId) where.workspaceId = workspaceId;
    const statusLower = status?.toUpperCase();
    if (statusLower === 'PENDING') { where.acceptedAt = null; where.revokedAt = null; where.expiresAt = { gt: new Date() }; }
    else if (statusLower === 'ACCEPTED') { where.acceptedAt = { not: null }; }
    else if (statusLower === 'REVOKED') { where.revokedAt = { not: null }; }
    else if (statusLower === 'EXPIRED') { where.acceptedAt = null; where.revokedAt = null; where.expiresAt = { lte: new Date() }; }

    const [invitations, total] = await Promise.all([
      userorgPrisma.invitation.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      userorgPrisma.invitation.count({ where }),
    ]);
    return { invitations: invitations.map((inv :any) => ({ ...inv, status: this.getInvitationStatus(inv) })), total };
  }

  async revokeInvitation(invitationId: string, revokedBy: string): Promise<void> {
    const invitation = await userorgPrisma.invitation.findUnique({ where: { id: invitationId } });
    if (!invitation) throw new Error('Không tìm thấy lời mời!');
    if (invitation.acceptedAt) throw new Error('Không thể thu hồi lời mời đã được chấp nhận!');
    await userorgPrisma.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } });
    logger.info({ invitationId, revokedBy }, 'Invitation revoked');
  }

  async resendInvitation(invitationId: string): Promise<void> {
    const invitation = await userorgPrisma.invitation.findUnique({ where: { id: invitationId } });
    if (!invitation) throw new Error('Không tìm thấy lời mời!');
    const status = this.getInvitationStatus(invitation);
    if (status !== 'PENDING') throw new Error(`Không thể gửi lại lời mời với trạng thái: ${status}`);
    await this.sendInvitationEmail(invitation, invitation.inviterName || 'Admin');
    logger.info({ invitationId }, 'Invitation resent');
  }

  async rejectInvitation(token: string): Promise<void> {
    const invitation = await userorgPrisma.invitation.findUnique({ where: { token } });
    if (!invitation) throw new Error('Không tìm thấy lời mời!');
    const status = this.getInvitationStatus(invitation);
    if (status !== 'PENDING') throw new Error('Lời mời này không còn ở trạng thái chờ!');

    await userorgPrisma.invitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() }
    });

    logger.info({ invitationId: invitation.id }, 'Invitation rejected');

    await publishEvent(EventSubjects.WORKSPACE_INVITE_REJECTED, {
      workspaceId: invitation.workspaceId,
      email: invitation.email,
      inviteId: invitation.id,
      inviterId: invitation.invitedBy
    });
  }
}

export const invitationService = new InvitationService();
