// ============= Auth DTOs =============

export interface RegisterDto {
  email: string;
  password: string;
  name: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthResponseDto {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: UserDto;
}

export interface RefreshTokenDto {
  refreshToken: string;
}

// ============= User DTOs =============

export interface UserDto {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: string;
  isActive: boolean;
  isOnline: boolean;
  lastSeen?: string;
  createdAt: string;
}

export interface UpdateUserDto {
  name?: string;
  avatar?: string;
  status?: string;
}

export interface UserProfileDto extends UserDto {
  status?: string;
  groups: GroupDto[];
}

// ============= Group DTOs =============

export interface GroupDto {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
  ownerId: string;
  avatar?: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupDto {
  name: string;
  type?: string;
  isPrivate?: boolean;
  memberIds?: string[];
}

export interface UpdateGroupDto {
  name?: string;
  isPrivate?: boolean;
  avatar?: string;
}

export interface GroupMemberDto {
  userId: string;
  user: UserDto;
  role: string;
  joinedAt: string;
}

export interface GroupDetailDto extends GroupDto {
  members: GroupMemberDto[];
  lastMessage?: MessageDto;
  unreadCount?: number;
}

export interface AddGroupMemberDto {
  userId: string;
  role?: string;
}

// ============= Message DTOs =============

export interface MessageDto {
  id: string;
  groupId: string;
  senderId: string;
  sender: UserDto;
  body?: string;
  type: string;
  hasAttachments: boolean;
  attachments?: FileDto[];
  replyTo?: MessageDto;
  reactions?: ReactionSummaryDto[];
  createdAt: string;
}

export interface SendMessageDto {
  body?: string;
  type?: string;
  replyToId?: string;
  attachmentIds?: string[];
}

export interface ReactionSummaryDto {
  reaction: string;
  count: number;
  users: { id: string; name: string }[];
  hasReacted: boolean;
}

export interface MessageSearchResultDto {
  message: MessageDto;
  highlight?: string;
}

// ============= File DTOs =============

export interface FileDto {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

export interface PresignUploadDto {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface PresignUploadResponseDto {
  fileId: string;
  uploadUrl: string;
  expiresIn: number;
}

export interface FileMetadataDto {
  id: string;
  s3Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploaderId: string;
  downloadUrl: string;
  createdAt: string;
}

// ============= Stats DTOs =============

export interface UserStatsDto {
  userId: string;
  userName: string;
  messageCount: number;
  avgResponseTimeMs?: number;
  activeGroups: number;
}

export interface GroupStatsDto {
  groupId: string;
  groupName: string;
  messageCount: number;
  memberCount: number;
  activeMembers: number;
  avgResponseTimeMs?: number;
}

export interface DailyStatsDto {
  date: string;
  messageCount: number;
  activeUsers: number;
  activeGroups: number;
}

export interface StatsOverviewDto {
  totalUsers: number;
  activeUsers: number;
  totalGroups: number;
  activeGroups: number;
  totalMessages: number;
  messagesLast24h: number;
  avgResponseTimeMs: number;
}

export interface StatsExportDto {
  format: 'csv' | 'pdf';
  fromDate: string;
  toDate: string;
  groupId?: string;
  userId?: string;
}

// ============= Notification DTOs =============

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

// ============= Common DTOs =============

export interface PaginationDto {
  page: number;
  limit: number;
}

export interface PaginatedResultDto<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface ErrorResponseDto {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, string[]>;
}

export interface SuccessResponseDto<T = unknown> {
  success: true;
  data: T;
  message?: string;
}
