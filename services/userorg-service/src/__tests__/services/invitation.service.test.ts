import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockPrisma, mockPublishEvent } from '../setup.js';

let invitationService: typeof import('../../services/invitation.service.js').invitationService;

beforeAll(async () => {
  ({ invitationService } = await import('../../services/invitation.service.js'));
});

describe('InvitationService', () => {
  beforeEach(() => {
    mockPrisma.invitation.findUnique.mockReset();
    mockPrisma.invitation.findMany.mockReset();
    mockPrisma.invitation.create.mockReset();
    mockPrisma.invitation.update.mockReset();
    mockPrisma.invitation.count.mockReset();
    mockPrisma.account.create.mockReset();
    mockPublishEvent.mockReset();
  });

  describe('createInvitation', () => {
    it('should create invitation with token and expiry', async () => {
      const mockInvitation = {
        id: 'inv-1',
        email: 'new@test.com',
        token: 'random-token',
        type: 'USER',
        channelIds: [],
        workspaceId: null,
        invitedBy: 'admin-1',
        inviterName: 'Admin',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };

      mockPrisma.invitation.findUnique.mockResolvedValue(null); // No existing invitation
      mockPrisma.invitation.create.mockResolvedValue(mockInvitation);

      const result = await invitationService.createInvitation({
        email: 'new@test.com',
        type: 'USER',
        invitedBy: 'admin-1',
        inviterName: 'Admin',
      });

      expect(result.email).toBe('new@test.com');
      expect(result.type).toBe('USER');
      expect(result.status).toBe('pending');
      expect(mockPrisma.invitation.create).toHaveBeenCalled();
    });

    it('should throw for invalid email', async () => {
      await expect(
        invitationService.createInvitation({
          email: 'invalid-email',
          type: 'USER',
          invitedBy: 'admin-1',
          inviterName: 'Admin',
        })
      ).rejects.toThrow();
    });
  });

  describe('validateToken', () => {
    it('should return invitation for valid token', async () => {
      const mockInvitation = {
        id: 'inv-1',
        email: 'test@test.com',
        token: 'valid-token',
        type: 'USER',
        expiresAt: new Date(Date.now() + 86400000),
        acceptedAt: null,
        revokedAt: null,
      };

      mockPrisma.invitation.findUnique.mockResolvedValue(mockInvitation);

      const result = await invitationService.validateToken('valid-token');

      expect(result).not.toBeNull();
      expect(result?.status).toBe('pending');
    });

    it('should return null for invalid token', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue(null);

      const result = await invitationService.validateToken('invalid-token');

      expect(result).toBeNull();
    });

    it('should mark expired invitation', async () => {
      const mockInvitation = {
        id: 'inv-1',
        email: 'test@test.com',
        token: 'expired-token',
        type: 'USER',
        expiresAt: new Date(Date.now() - 86400000), // Yesterday
        acceptedAt: null,
        revokedAt: null,
      };

      mockPrisma.invitation.findUnique.mockResolvedValue(mockInvitation);

      const result = await invitationService.validateToken('expired-token');

      expect(result?.status).toBe('expired');
    });
  });

  describe('listInvitations', () => {
    it('should return paginated invitations', async () => {
      const mockInvitations = [
        { id: 'inv-1', email: 'user1@test.com', status: 'pending' },
        { id: 'inv-2', email: 'user2@test.com', status: 'accepted' },
      ];
      mockPrisma.invitation.findMany.mockResolvedValue(mockInvitations);
      mockPrisma.invitation.count.mockResolvedValue(2);

      const result = await invitationService.listInvitations({
        page: 1,
        limit: 10,
      });

      expect(result.invitations.length).toBe(2);
      expect(result.total).toBe(2);
    });

    it('should filter by status', async () => {
      mockPrisma.invitation.findMany.mockResolvedValue([]);
      mockPrisma.invitation.count.mockResolvedValue(0);

      await invitationService.listInvitations({ status: 'pending' });

      expect(mockPrisma.invitation.findMany).toHaveBeenCalled();
    });
  });

  describe('revokeInvitation', () => {
    it('should revoke pending invitation', async () => {
      const mockInvitation = {
        id: 'inv-1',
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockPrisma.invitation.findUnique.mockResolvedValue(mockInvitation);
      mockPrisma.invitation.update.mockResolvedValue({
        ...mockInvitation,
        revokedAt: new Date(),
      });

      await invitationService.revokeInvitation('inv-1', 'admin-1');

      expect(mockPrisma.invitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-1' },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('should throw for already accepted invitation', async () => {
      const mockInvitation = {
        id: 'inv-1',
        acceptedAt: new Date(),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockPrisma.invitation.findUnique.mockResolvedValue(mockInvitation);

      await expect(
        invitationService.revokeInvitation('inv-1', 'admin-1')
      ).rejects.toThrow();
    });
  });
});
