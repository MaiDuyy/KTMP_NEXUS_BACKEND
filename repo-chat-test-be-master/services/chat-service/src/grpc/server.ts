import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
// import { ProtoGrpcType } from '../grpc/generated/chat'; // generated types
import { messageService } from '../services/message.service.js';
import { mentionService } from '../services/mention.service.js';
import { readReceiptService } from '../services/readreceipt.service.js';
import { threadService } from '../services/thread.service.js';
import { logger } from '../lib/logger.js';

const PROTO_PATH = '../proto/chat.proto';
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition) as any;

// Helper to extract user ID from metadata
function getUserId(call: grpc.ServerUnaryCall<any, any>): string {
  const metadata = call.metadata;
  const userId = metadata.get('x-user-id')[0] as string;
  if (!userId) {
    throw new Error('Missing x-user-id in metadata');
  }
  return userId;
}

// Helper to handle errors
function handleError(error: any, callback: grpc.sendUnaryData<any>) {
  logger.error(error);
  callback({
    code: grpc.status.INTERNAL,
    message: error.message,
  });
}

export class ChatServiceServer {
  private server: grpc.Server;

  constructor() {
    this.server = new grpc.Server();
    this.server.addService(proto.chat.ChatService.service, {
      // Mention
      GetMentions: this.getMentions.bind(this),
      GetUnreadMentionCount: this.getUnreadMentionCount.bind(this),

      // Message
      GetMessages: this.getMessages.bind(this),
      SendMessage: this.sendMessage.bind(this),
      DeleteMessageForMe: this.deleteMessageForMe.bind(this),
      RecallMessage: this.recallMessage.bind(this),
      ReactMessage: this.reactMessage.bind(this),
      TogglePinMessage: this.togglePinMessage.bind(this),
      GetPinnedMessages: this.getPinnedMessages.bind(this),
      SearchMessages: this.searchMessages.bind(this),
      GetMediaMessages: this.getMediaMessages.bind(this),

      // Read Receipt
      MarkAsRead: this.markAsRead.bind(this),
      GetReadReceipts: this.getReadReceipts.bind(this),
      GetUnreadCount: this.getUnreadCount.bind(this),
      GetBatchUnreadCounts: this.getBatchUnreadCounts.bind(this),

      // Thread
      CreateThreadReply: this.createThreadReply.bind(this),
      GetThreadReplies: this.getThreadReplies.bind(this),
      GetThreadPreview: this.getThreadPreview.bind(this),
      GetThreadParticipants: this.getThreadParticipants.bind(this),
      GetActiveThreads: this.getActiveThreads.bind(this),
    });
  }

  // ---------- Mention ----------
  private async getMentions(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { cursor, limit } = call.request;
      const result = await mentionService.getMentionsForUser(userId, { cursor, limit });
      callback(null, result);
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getUnreadMentionCount(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { since } = call.request;
      const count = await mentionService.getUnreadMentionCount(
        userId,
        since ? new Date(since) : undefined
      );
      callback(null, { unreadCount: count });
    } catch (error) {
      handleError(error, callback);
    }
  }

  // ---------- Message ----------
  private async getMessages(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId, cursor, limit } = call.request;
      const result = await messageService.getMessages(chatId, userId, { cursor, limit });
      callback(null, result);
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async sendMessage(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId, content, type, replyToId, fileName, fileSize, fileType } = call.request;
      const message = await messageService.sendMessage(chatId, userId, {
        content,
        type,
        replyToId,
        fileName,
        fileSize,
        fileType,
      });
      // Convert to proto Message format
      callback(null, { message: this.toProtoMessage(message, userId) });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async deleteMessageForMe(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { messageId } = call.request;
      await messageService.deleteMessageForMe(messageId, userId);
      callback(null, {});
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async recallMessage(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { messageId } = call.request;
      await messageService.recallMessage(messageId, userId);
      callback(null, {});
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async reactMessage(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { messageId, emoji } = call.request;
      const result = await messageService.reactMessage(messageId, userId, emoji);
      callback(null, result);
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async togglePinMessage(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { messageId } = call.request;
      const { pin } = await messageService.togglePinMessage(messageId, userId);
      callback(null, { pin });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getPinnedMessages(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId } = call.request;
      const messages = await messageService.getPinnedMessages(chatId);
      callback(null, {
        pinnedMessages: messages.map((msg: any) => ({
          id: msg.id,
          content: msg.content,
          type: msg.type,
          time: msg.time.toISOString(),
          senderId: msg.senderId,
        })),
      });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async searchMessages(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId, query } = call.request;
      const messages = await messageService.searchMessages(chatId, query);
      callback(null, {
        messages: messages.map((msg: any) => ({
          id: msg.id,
          content: msg.content,
          time: msg.time.toISOString(),
          senderId: msg.senderId,
        })),
      });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getMediaMessages(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId, type } = call.request;
      const messages = await messageService.getMediaMessages(chatId, type);
      callback(null, {
        media: messages.map((msg: any) => ({
          id: msg.id,
          content: msg.content,
          type: msg.type,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          fileType: msg.fileType,
          time: msg.time.toISOString(),
          senderId: msg.senderId,
        })),
      });
    } catch (error) {
      handleError(error, callback);
    }
  }

  // ---------- Read Receipt ----------
  private async markAsRead(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId, messageId } = call.request;
      const receipt = await readReceiptService.markAsRead(chatId, userId, messageId);
      callback(null, {
        receipt: {
          chatId: receipt?.chatId || '',
          messageId: receipt?.messageId || '',
          readAt: receipt?.readAt?.toISOString() || '',
        },
      });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getReadReceipts(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId } = call.request;
      const receipts = await readReceiptService.getReadReceipts(chatId);
      callback(null, {
        receipts: receipts.map((r: any) => ({
          userId: r.userId,
          messageId: r.messageId,
          readAt: r.readAt.toISOString(),
        })),
      });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getUnreadCount(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId } = call.request;
      const count = await readReceiptService.getUnreadCount(chatId, userId);
      callback(null, { unreadCount: count });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getBatchUnreadCounts(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatIds } = call.request;
      const counts = await readReceiptService.getBatchUnreadCounts(chatIds, userId);
      callback(null, { unreadCounts: counts });
    } catch (error) {
      handleError(error, callback);
    }
  }

  // ---------- Thread ----------
  private async createThreadReply(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { parentId, content, type, fileName, fileSize, fileType } = call.request;
      const reply = await threadService.createThreadReply(parentId, userId, {
        content,
        type,
        fileName,
        fileSize,
        fileType,
      });
      callback(null, {
        reply: {
          id: reply.id,
          parentId: reply.parentId,
          content: reply.content,
          type: reply.type,
          time: reply.time.toISOString(),
          senderId: reply.senderId,
          file: reply.fileName
            ? { name: reply.fileName, size: reply.fileSize, type: reply.fileType }
            : undefined,
        },
      });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getThreadReplies(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { parentId, cursor, limit } = call.request;
      const result = await threadService.getThreadReplies(parentId, { cursor, limit });
      callback(null, result);
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getThreadPreview(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { parentId } = call.request;
      const preview = await threadService.getThreadPreview(parentId);
      callback(null, { preview });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getThreadParticipants(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { parentId } = call.request;
      const participants = await threadService.getThreadParticipants(parentId);
      callback(null, { participants });
    } catch (error) {
      handleError(error, callback);
    }
  }

  private async getActiveThreads(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ) {
    try {
      const userId = getUserId(call);
      const { chatId, limit } = call.request;
      const threads = await threadService.getActiveThreads(chatId, limit);
      callback(null, { threads });
    } catch (error) {
      handleError(error, callback);
    }
  }

  // Helper: Convert internal message to proto Message
  private toProtoMessage(msg: any, currentUserId: string) {
    return {
      id: msg.id,
      chatId: msg.chatId,
      senderId: msg.senderId,
      content: msg.content,
      type: msg.type,
      time: msg.time.toISOString(),
      pin: msg.pin,
      replyTo: msg.replyTo
        ? {
            id: msg.replyTo.id,
            content: msg.replyTo.content,
            type: msg.replyTo.type,
            senderId: msg.replyTo.senderId,
          }
        : undefined,
      file: msg.fileName
        ? { name: msg.fileName, size: msg.fileSize, type: msg.fileType }
        : undefined,
      reactions: this.groupReactions(msg.reactions),
      isMe: msg.senderId === currentUserId,
    };
  }

  private groupReactions(reactions: any[]) {
    const map = new Map<string, { count: number; userIds: string[] }>();
    for (const r of reactions) {
      const existing = map.get(r.reaction);
      if (existing) {
        existing.count++;
        existing.userIds.push(r.userId);
      } else {
        map.set(r.reaction, { count: 1, userIds: [r.userId] });
      }
    }
    return Array.from(map.entries()).map(([emoji, data]) => ({
      emoji,
      count: data.count,
      userIds: data.userIds,
    }));
  }

  start(port: string) {
    this.server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) {
        logger.error(err, 'Failed to start gRPC server');
        return;
      }
      this.server.start();
      logger.info(`gRPC server running on port ${boundPort}`);
    });
  }
}