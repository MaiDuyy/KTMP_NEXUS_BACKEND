import { z } from 'zod';

// ============= Auth Schemas =============

export const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ============= User Schemas =============

export const updateUserSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  avatar: z.string().url().optional(),
  status: z.string().max(200).optional(),
});

export const userRoleSchema = z.enum(['ADMIN', 'MANAGER', 'STAFF', 'USER']);

// ============= Group Schemas =============

export const createGroupSchema = z.object({
  name: z.string().min(1, 'Group name is required').max(160),
  type: z.enum(['DEPARTMENT', 'PROJECT', 'DM', 'GENERAL']).default('GENERAL'),
  isPrivate: z.boolean().default(false),
  memberIds: z.array(z.string()).optional(),
});

export const updateGroupSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  isPrivate: z.boolean().optional(),
  avatar: z.string().url().optional(),
});

export const addMemberSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).default('MEMBER'),
});

// ============= Message Schemas =============

export const sendMessageSchema = z.object({
  body: z.string().max(10000).optional(),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'FILE', 'AUDIO', 'SYSTEM']).default('TEXT'),
  replyToId: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
});

export const searchMessageSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  groupId: z.string().optional(),
  senderId: z.string().optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

// ============= File Schemas =============

export const presignUploadSchema = z.object({
  fileName: z.string().min(1, 'File name is required'),
  contentType: z.string().min(1, 'Content type is required'),
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024, 'File size must be less than 20MB'),
});

export const allowedMimeTypes = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
] as const;

// ============= Stats Schemas =============

export const statsQuerySchema = z.object({
  groupId: z.string().optional(),
  userId: z.string().optional(),
  fromDate: z.string().datetime(),
  toDate: z.string().datetime(),
});

// ============= Pagination Schema =============

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Export types inferred from schemas
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type SearchMessageInput = z.infer<typeof searchMessageSchema>;
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
export type StatsQueryInput = z.infer<typeof statsQuerySchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;
export * from './meetingAiStream.schema.js';
