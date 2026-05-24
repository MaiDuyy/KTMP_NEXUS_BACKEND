// NATS Event Subjects
export const EventSubjects = {
  // User events
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DELETED: 'user.deleted',
  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',

  // Group events
  GROUP_CREATED: 'group.created',
  GROUP_UPDATED: 'group.updated',
  GROUP_DELETED: 'group.deleted',
  GROUP_MEMBER_ADDED: 'group.member.added',
  GROUP_MEMBER_REMOVED: 'group.member.removed',
  GROUP_MEMBER_ROLE_CHANGED: 'group.member.role_changed',

  // Message events
  MESSAGE_CREATED: 'message.created',
  MESSAGE_UPDATED: 'message.updated',
  MESSAGE_DELETED: 'message.deleted',
  MESSAGE_READ: 'message.read',
  MESSAGE_REACTION: 'message.reaction',

  // File events
  FILE_UPLOADED: 'file.uploaded',
  FILE_DELETED: 'file.deleted',

  // Stats events
  STATS_ROLLUP_REQUESTED: 'stats.rollup.requested',
  STATS_ROLLUP_COMPLETED: 'stats.rollup.completed',

  // Notification events
  NOTIFICATION_CREATED: 'notification.created',

  // Typing events
  TYPING_START: 'typing.start',
  TYPING_STOP: 'typing.stop',

  // System events
  SYSTEM_BROADCAST: 'system.broadcast',

  // Organization events
  ORGANIZATION_CREATED: 'organization.created',
  WORKSPACE_QUOTA_UPDATED: 'workspace.quota.updated',

  // RBAC events
  RBAC_UPDATED: 'rbac.updated',

  // Admin/Audit events
  AUDIT_LOG_CREATED: 'admin.audit_log.created',
} as const;

export type EventSubject = typeof EventSubjects[keyof typeof EventSubjects];

// Event Payloads
export interface SystemBroadcastEvent {
  title: string;
  body: string;
  senderId: string;
  type: 'ANNOUNCEMENT' | 'MAINTENANCE' | 'ALERT';
  data?: Record<string, unknown>;
}
export interface UserCreatedEvent {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

export interface UserUpdatedEvent {
  id: string;
  name?: string;
  avatar?: string;
  role?: string;
  isActive?: boolean;
}

export interface UserOnlineEvent {
  userId: string;
  timestamp: string;
}

export interface UserOfflineEvent {
  userId: string;
  lastSeen: string;
}

export interface GroupCreatedEvent {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
  ownerId: string;
  createdAt: string;
}

export interface GroupMemberAddedEvent {
  chatId: string;
  addedMemberIds?: string[];
  allMemberIds?: string[];
  addedBy: string;
  // Legacy support
  groupId?: string;
  userId?: string;
  role?: string;
}

export interface GroupMemberRemovedEvent {
  chatId: string;
  userId: string;
  removedBy: string;
  memberIds?: string[]; // remaining members
  isSelfLeave?: boolean;
  reason?: string;
  // Legacy support
  groupId?: string;
}

export interface MessageCreatedEvent {
  id: string;
  groupId: string;
  senderId: string;
  body?: string;
  type: string;
  hasAttachments: boolean;
  createdAt: string;
}

export interface MessageReadEvent {
  messageId: string;
  userId: string;
  groupId: string;
  readAt: string;
}

export interface MessageReactionEvent {
  messageId: string;
  userId: string;
  groupId: string;
  reaction: string;
  action: 'add' | 'remove';
}

export interface FileUploadedEvent {
  id: string;
  s3Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploaderId: string;
  createdAt: string;
}

export interface TypingEvent {
  groupId: string;
  userId: string;
  userName: string;
}

export interface NotificationCreatedEvent {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface OrganizationCreatedEvent {
  orgId: string;
  orgName: string;
  adminId: string;
  workspaceName?: string;
  workspaceSlug?: string;
  createdAt: string;
}

export interface WorkspaceQuotaUpdatedEvent {
  orgId: string;
  used: number;
  limit: number;
}

export interface RbacUpdatedEvent {
  userId: string;
  role: string;
  scope: 'SYSTEM' | 'WORKSPACE' | 'CHANNEL';
  scopeId?: string;
}

export interface AuditLogCreatedEvent {
  id: string;
  userId: string;
  action: string;
  resource: string;
  data: any;
  createdAt: string;
}

// Generic event wrapper
export interface NatsEvent<T = unknown> {
  subject: EventSubject;
  payload: T;
  timestamp: string;
  correlationId?: string;
}
