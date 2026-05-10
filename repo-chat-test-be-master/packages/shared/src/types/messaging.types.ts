// packages/shared/src/types/messaging.types.ts
// Shared types for Module 1: Messaging

// ============= Thread Types =============

export interface ThreadReply {
  id: string;
  parentId: string;
  rootThreadId: string | null;
  chatId: string;
  content: string | null;
  type: string;
  senderId: string;
  time: Date;
  file?: {
    name: string;
    size: string | null;
    type: string | null;
  } | null;
}

export interface ThreadPreview {
  parentId: string;
  replyCount: number;
  latestReplies: {
    id: string;
    senderId: string;
    content: string | null;
    time: Date;
  }[];
}

// ============= Mention Types =============

export type MentionTargetType = 'USER' | 'HERE' | 'CHANNEL';

export interface Mention {
  id: string;
  messageId: string;
  targetType: MentionTargetType;
  targetId: string | null;
  createdAt: Date;
}

export interface MentionNotification {
  chatId: string;
  messageId: string;
  senderId: string;
  content: string | null;
  time: Date;
  mentionedAt: Date;
}

// ============= Read Receipt Types =============

export interface ReadReceipt {
  userId: string;
  messageId: string;
  readAt: Date;
}

export interface UnreadCounts {
  [chatId: string]: number;
}

// ============= Socket.io Event Types =============

export interface ThreadReplyEvent {
  chatId: string;
  parentId: string;
  reply: Omit<ThreadReply, 'chatId'>;
}

export interface MentionNewEvent {
  chatId: string;
  messageId: string;
  mentionedBy: string;
  timestamp: string;
}

export interface MentionBroadcastEvent {
  chatId: string;
  messageId: string;
  mentionedBy: string;
  types: MentionTargetType[];
}

export interface MessageEditedEvent {
  chatId: string;
  messageId: string;
  content: string;
  editedAt: string;
}

export interface SocketMessageReadEvent {
  chatId: string;
  userId: string;
  messageId: string;
  readAt: string;
}

// ============= API Response Types =============

export interface ThreadRepliesResponse {
  success: boolean;
  parentId: string;
  chatId: string;
  totalReplies: number;
  replies: ThreadReply[];
  nextCursor: string | null;
}

export interface MentionsResponse {
  success: boolean;
  mentions: MentionNotification[];
  nextCursor: string | null;
}
