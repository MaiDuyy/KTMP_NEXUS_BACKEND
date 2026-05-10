// packages/shared/src/types/userorg.types.ts
// Shared types for User & Organization Management (Module 3)

// USER-03: Enhanced user status
export enum UserStatus {
  ONLINE = 'ONLINE',
  AWAY = 'AWAY',
  DND = 'DND',       // Do Not Disturb
  INVISIBLE = 'INVISIBLE',
}

// USER-07, USER-10: Invitation types
export enum InvitationType {
  USER = 'USER',    // Full user invitation
  GUEST = 'GUEST',  // External guest (limited access)
}

// Invitation payload for creating invitations
export interface CreateInvitationDto {
  email: string;
  type: InvitationType;
  channelIds?: string[];  // For guest invitations
  workspaceId?: string;
}

// Invitation response
export interface InvitationDto {
  id: string;
  email: string;
  type: InvitationType;
  channelIds: string[];
  workspaceId?: string;
  invitedBy: string;
  inviterName?: string;
  expiresAt: Date;
  acceptedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
}

// Accept invitation payload
export interface AcceptInvitationDto {
  name: string;
  password: string;
  gender?: string;
}

// USER-08: Suspension
export interface SuspendUserDto {
  reason: string;
}

export interface SuspensionInfo {
  isSuspended: boolean;
  suspendedAt?: Date;
  suspendedBy?: string;
  suspendReason?: string;
}

// USER-09: Deletion options
export interface DeleteUserOptions {
  anonymize?: boolean;  // If true, anonymize instead of hard delete
}

// USER-04: Custom status
export interface SetCustomStatusDto {
  text: string | null;
  emoji?: string | null;
  expiryHours?: number;  // Auto-clear after N hours (0 = no expiry)
}

// USER-12: Organization settings
export interface OrgSettingsDto {
  companyName: string;
  logoUrl?: string;
  timezone: string;
  language: string;
  allowGuestInvite: boolean;
  allowUserInvite: boolean;
  defaultUserRole: string;
  messageRetentionDays: number;
  fileRetentionDays: number;
}

export interface UpdateOrgSettingsDto {
  companyName?: string;
  logoUrl?: string;
  timezone?: string;
  language?: string;
  allowGuestInvite?: boolean;
  allowUserInvite?: boolean;
  defaultUserRole?: string;
  messageRetentionDays?: number;
  fileRetentionDays?: number;
}

// User profile with enhanced status (userorg module)
export interface UserOrgProfileDto {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  userStatus: UserStatus;
  customStatus?: string;
  customStatusEmoji?: string;
  isOnline: boolean;
  lastSeen?: Date;
  isSuspended: boolean;
}

// Email job payload for RabbitMQ
export interface InvitationEmailPayload {
  to: string;
  template: 'invitation';
  data: {
    inviteUrl: string;
    inviterName: string;
    orgName: string;
    expiresAt: string;
    type: InvitationType;
  };
}

// NATS event types for userorg
export enum UserOrgEvents {
  USER_STATUS_CHANGED = 'user.status.changed',
  USER_SUSPENDED = 'user.suspended',
  USER_UNSUSPENDED = 'user.unsuspended',
  USER_ANONYMIZED = 'user.anonymized',
  INVITATION_CREATED = 'invitation.created',
  INVITATION_ACCEPTED = 'invitation.accepted',
  ORG_SETTINGS_UPDATED = 'org.settings.updated',
}

// Event payloads
export interface UserStatusChangedEvent {
  userId: string;
  userStatus: UserStatus;
  customStatus?: string;
  customStatusEmoji?: string;
  timestamp: Date;
}

export interface UserSuspendedEvent {
  userId: string;
  suspendedBy: string;
  reason: string;
  timestamp: Date;
}

export interface InvitationCreatedEvent {
  invitationId: string;
  email: string;
  type: InvitationType;
  invitedBy: string;
  timestamp: Date;
}
