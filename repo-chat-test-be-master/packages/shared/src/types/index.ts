// Re-export all types from modules
export * from './userorg.types.js';
export * from './rbac.types.js';
export * from './messaging.types.js';

// User types
export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: UserRole;
  isActive: boolean;
  isOnline: boolean;
  lastSeen?: Date;
  createdAt: Date;
  updatedAt: Date;
  isSuspended?: boolean;
  suspendedAt?: Date;
  suspendedBy?: string;
  suspendReason?: string;
}

export type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF' | 'USER';

// Group types
export interface Group {
  id: string;
  name: string;
  type: GroupType;
  isPrivate: boolean;
  ownerId: string;
  avatar?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type GroupType = 'DEPARTMENT' | 'PROJECT' | 'DM' | 'GENERAL';

export interface GroupMember {
  groupId: string;
  userId: string;
  role: MemberRole;
  joinedAt: Date;
}

export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';

// Message types
export interface Message {
  id: string;
  groupId: string;
  senderId: string;
  body?: string;
  type: MessageType;
  hasAttachments: boolean;
  replyToId?: string;
  createdAt: Date;
}

export type MessageType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'FILE' | 'AUDIO' | 'SYSTEM';

export interface MessageRead {
  messageId: string;
  userId: string;
  readAt: Date;
}

// File types
export interface FileMetadata {
  id: string;
  s3Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploaderId: string;
  createdAt: Date;
}

export interface MessageAttachment {
  messageId: string;
  fileId: string;
}

// Stats types
export interface UserDailyStats {
  userId: string;
  date: Date;
  msgCount: number;
}

export interface GroupDailyStats {
  groupId: string;
  date: Date;
  msgCount: number;
  avgResponseMs?: number;
}

// Auth types
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

export interface RefreshToken {
  id: string;
  userId: string;
  jti: string;
  expiresAt: Date;
  createdAt: Date;
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
