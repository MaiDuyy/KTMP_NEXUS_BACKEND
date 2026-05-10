import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import { chatService } from '../services/chat.service.js';
import { workspaceService } from '../services/workspace.service.js';
import { channelService } from '../services/channel.service.js';
import { channelCategoryService } from '../services/channel-category.service.js';
import { logger } from '../lib/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.join(__dirname, '../../proto/group.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDefinition) as any;

// Helper: extract user ID from metadata
function getUserId(call: grpc.ServerUnaryCall<any, any>): string {
  const userId = call.metadata.get('x-user-id')[0] as string;
  if (!userId) throw new Error('Missing x-user-id in metadata');
  return userId;
}

// Helper: handle errors
function handleError(error: any, callback: grpc.sendUnaryData<any>) {
  logger.error(error);
  callback({ code: grpc.status.INTERNAL, message: error.message });
}

export class GroupServiceServer {
  private server: grpc.Server;

  constructor() {
    this.server = new grpc.Server();
    this.server.addService(proto.group.GroupService.service, {
      // Chat
      GetChats: this.getChats.bind(this),
      GetChat: this.getChat.bind(this),
      CreateGroupChat: this.createGroupChat.bind(this),
      GetOrCreatePrivateChat: this.getOrCreatePrivateChat.bind(this),
      UpdateChat: this.updateChat.bind(this),
      AddMembers: this.addMembers.bind(this),
      RemoveMember: this.removeMember.bind(this),
      TogglePin: this.togglePin.bind(this),
      ToggleNotify: this.toggleNotify.bind(this),
      MarkChatAsRead: this.markChatAsRead.bind(this),
      DeleteChat: this.deleteChat.bind(this),

      // Workspace
      CreateWorkspace: this.createWorkspace.bind(this),
      GetWorkspace: this.getWorkspace.bind(this),
      GetUserWorkspaces: this.getUserWorkspaces.bind(this),
      UpdateWorkspace: this.updateWorkspace.bind(this),
      DeleteWorkspace: this.deleteWorkspace.bind(this),
      AddWorkspaceMember: this.addWorkspaceMember.bind(this),
      RemoveWorkspaceMember: this.removeWorkspaceMember.bind(this),
      UpdateMemberRole: this.updateMemberRole.bind(this),
      GetWorkspaceMembers: this.getWorkspaceMembers.bind(this),

      // Channel
      CreateChannel: this.createChannel.bind(this),
      GetChannel: this.getChannel.bind(this),
      ListChannels: this.listChannels.bind(this),
      UpdateChannel: this.updateChannel.bind(this),
      ArchiveChannel: this.archiveChannel.bind(this),
      DeleteChannel: this.deleteChannel.bind(this),
      AddChannelMember: this.addChannelMember.bind(this),
      RemoveChannelMember: this.removeChannelMember.bind(this),
      UpdateChannelPermission: this.updateChannelPermission.bind(this),
      JoinChannel: this.joinChannel.bind(this),
      BrowseChannels: this.browseChannels.bind(this),
      CanUserPost: this.canUserPost.bind(this),

      // Channel Category
      CreateCategory: this.createCategory.bind(this),
      ListCategories: this.listCategories.bind(this),
      UpdateCategory: this.updateCategory.bind(this),
      DeleteCategory: this.deleteCategory.bind(this),
      ReorderCategories: this.reorderCategories.bind(this),
      MoveChannelToCategory: this.moveChannelToCategory.bind(this),
    });
  }

  // ==================== CHAT ====================

  private async getChats(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { type } = call.request;
      const chats = await chatService.getChats(userId, type || 'all');
      callback(null, { chats: chats.map(this.toChatItem) });
    } catch (error) { handleError(error, callback); }
  }

  private async getChat(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { chat_id } = call.request;
      const chat = await chatService.getChatById(chat_id, userId);
      callback(null, { chat: this.toChatItem(chat) });
    } catch (error) { handleError(error, callback); }
  }

  private async createGroupChat(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { name, member_ids, avatar } = call.request;
      const chat = await chatService.createGroupChat(userId, name, member_ids, avatar);
      callback(null, { chat: this.toChatItem(chat) });
    } catch (error) { handleError(error, callback); }
  }

  private async getOrCreatePrivateChat(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { partner_id } = call.request;
      const result = await chatService.getOrCreatePrivateChat(userId, partner_id);
      callback(null, {
        chat_id: result.chat.id,
        is_group: result.chat.isGroup,
        partner_id: result.chat.partnerId,
        created: result.created,
      });
    } catch (error) { handleError(error, callback); }
  }

  private async updateChat(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { chat_id, name, avatar } = call.request;
      const updated = await chatService.updateChat(chat_id, userId, { name, avatar });
      callback(null, { id: updated.id, name: updated.name, avatar: updated.avatar });
    } catch (error) { handleError(error, callback); }
  }

  private async addMembers(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { chat_id, member_ids } = call.request;
      const result = await chatService.addMembers(chat_id, userId, member_ids);
      callback(null, { added_count: result.addedCount });
    } catch (error) { handleError(error, callback); }
  }

  private async removeMember(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { chat_id, member_id } = call.request;
      const result = await chatService.removeMember(chat_id, userId, member_id);
      callback(null, { is_self_leave: result.isSelfLeave });
    } catch (error) { handleError(error, callback); }
  }

  private async togglePin(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { chat_id, pin } = call.request;
      const result = await chatService.togglePin(chat_id, userId, pin);
      callback(null, { pin: result.pin });
    } catch (error) { handleError(error, callback); }
  }

  private async toggleNotify(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { chat_id, notify } = call.request;
      const result = await chatService.toggleNotify(chat_id, userId, notify);
      callback(null, { notify: result.notify });
    } catch (error) { handleError(error, callback); }
  }

  private async markChatAsRead(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { chat_id } = call.request;
      await chatService.markAsRead(chat_id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async deleteChat(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { chat_id } = call.request;
      const result = await chatService.deleteChat(chat_id, userId);
      callback(null, { type: result.type });
    } catch (error) { handleError(error, callback); }
  }

  // ==================== WORKSPACE ====================

  private async createWorkspace(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { name, description, icon, slug, is_public, allow_guest_access } = call.request;
      const ws = await workspaceService.createWorkspace(
        { name, description, icon, slug, isPublic: is_public, allowGuestAccess: allow_guest_access },
        userId
      );
      callback(null, { workspace: this.toWorkspaceItem(ws) });
    } catch (error) { handleError(error, callback); }
  }

  private async getWorkspace(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { id_or_slug } = call.request;
      const ws = await workspaceService.getWorkspace(id_or_slug, userId);
      callback(null, { workspace: this.toWorkspaceItem(ws) });
    } catch (error) { handleError(error, callback); }
  }

  private async getUserWorkspaces(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const workspaces = await workspaceService.getUserWorkspaces(userId);
      callback(null, { workspaces: workspaces.map(this.toWorkspaceItem) });
    } catch (error) { handleError(error, callback); }
  }

  private async updateWorkspace(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { id, name, description, icon, is_public, allow_guest_access } = call.request;
      const ws = await workspaceService.updateWorkspace(
        id,
        { name, description, icon, isPublic: is_public, allowGuestAccess: allow_guest_access },
        userId
      );
      callback(null, { workspace: this.toWorkspaceItem(ws) });
    } catch (error) { handleError(error, callback); }
  }

  private async deleteWorkspace(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { id } = call.request;
      await workspaceService.deleteWorkspace(id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async addWorkspaceMember(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id, target_user_id, role } = call.request;
      const member = await workspaceService.addMember(workspace_id, target_user_id, role, userId);
      callback(null, this.toWorkspaceMemberItem(member));
    } catch (error) { handleError(error, callback); }
  }

  private async removeWorkspaceMember(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id, target_user_id } = call.request;
      await workspaceService.removeMember(workspace_id, target_user_id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async updateMemberRole(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id, target_user_id, new_role } = call.request;
      const member = await workspaceService.updateMemberRole(workspace_id, target_user_id, new_role, userId);
      callback(null, this.toWorkspaceMemberItem(member));
    } catch (error) { handleError(error, callback); }
  }

  private async getWorkspaceMembers(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const { workspace_id, page, limit } = call.request;
      const result = await workspaceService.getMembers(workspace_id, { page, limit });
      callback(null, {
        members: result.items.map(this.toWorkspaceMemberItem),
        total: result.total,
        page: result.page,
        total_pages: result.totalPages,
      });
    } catch (error) { handleError(error, callback); }
  }

  // ==================== CHANNEL ====================

  private async createChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id, name, description, topic, type, category_id, is_default } = call.request;
      const channel = await channelService.createChannel(
        workspace_id,
        { name, description, topic, type, categoryId: category_id, isDefault: is_default },
        userId
      );
      callback(null, { channel: this.toChannelItem(channel) });
    } catch (error) { handleError(error, callback); }
  }

  private async getChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id } = call.request;
      const channel = await channelService.getChannel(channel_id, userId);
      callback(null, { channel: this.toChannelItem(channel) });
    } catch (error) { handleError(error, callback); }
  }

  private async listChannels(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id, include_archived } = call.request;
      const channels = await channelService.listChannels(workspace_id, userId, include_archived);
      callback(null, { channels: channels.map(this.toChannelItem) });
    } catch (error) { handleError(error, callback); }
  }

  private async updateChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id, name, description, topic, category_id } = call.request;
      await channelService.updateChannel(channel_id, { name, description, topic, categoryId: category_id }, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async archiveChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id } = call.request;
      await channelService.archiveChannel(channel_id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async deleteChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id } = call.request;
      await channelService.deleteChannel(channel_id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async addChannelMember(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id, target_user_id } = call.request;
      await channelService.addMember(channel_id, target_user_id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async removeChannelMember(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id, target_user_id } = call.request;
      await channelService.removeMember(channel_id, target_user_id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async updateChannelPermission(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id, target_user_id, can_post } = call.request;
      await channelService.updateMemberPermission(channel_id, target_user_id, can_post, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async joinChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id } = call.request;
      await channelService.joinPublicChannel(channel_id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async browseChannels(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id, page, limit, search } = call.request;
      const result = await channelService.browseChannels(workspace_id, userId, { page, limit, search });
      callback(null, {
        items: result.items,
        total: result.total,
        page: result.page,
        total_pages: result.totalPages,
      });
    } catch (error) { handleError(error, callback); }
  }

  private async canUserPost(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const { channel_id, user_id } = call.request;
      const canPost = await channelService.canUserPost(channel_id, user_id);
      callback(null, { can_post: canPost });
    } catch (error) { handleError(error, callback); }
  }

  // ==================== CHANNEL CATEGORY ====================

  private async createCategory(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id, name, position } = call.request;
      const category = await channelCategoryService.createCategory(workspace_id, { name, position }, userId);
      callback(null, { category: this.toCategoryItem(category) });
    } catch (error) { handleError(error, callback); }
  }

  private async listCategories(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id } = call.request;
      const categories = await channelCategoryService.listCategories(workspace_id, userId);
      callback(null, { categories: categories.map(this.toCategoryItem) });
    } catch (error) { handleError(error, callback); }
  }

  private async updateCategory(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { category_id, name, position } = call.request;
      await channelCategoryService.updateCategory(category_id, { name, position }, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async deleteCategory(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { category_id } = call.request;
      await channelCategoryService.deleteCategory(category_id, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async reorderCategories(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { workspace_id, category_ids } = call.request;
      await channelCategoryService.reorderCategories(workspace_id, category_ids, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  private async moveChannelToCategory(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const userId = getUserId(call);
      const { channel_id, category_id } = call.request;
      await channelCategoryService.moveChannelToCategory(channel_id, category_id || null, userId);
      callback(null, {});
    } catch (error) { handleError(error, callback); }
  }

  // ==================== HELPERS ====================

  private toChatItem(chat: any) {
    return {
      id: chat.id,
      name: chat.name,
      avatar: chat.avatar,
      is_group: chat.isGroup,
      pin: chat.pin ?? false,
      notify: chat.notify ?? true,
      readed: chat.readed ?? false,
      participant_ids: chat.participantIds ?? [],
      participants: (chat.participants ?? []).map((p: any) => ({
        participant_id: p.participantId ?? p.id,
        account_id: p.accountId,
        role: p.role,
        name: p.name,
        avatar: p.avatar,
        is_online: p.isOnline,
      })),
      participant_count: chat.participantCount ?? (chat.participants?.length ?? 0),
      updated_at: chat.updatedAt?.toISOString?.() ?? chat.updatedAt ?? '',
      created_at: chat.createdAt?.toISOString?.() ?? chat.createdAt ?? '',
    };
  }

  private toWorkspaceItem(ws: any) {
    return {
      id: ws.id,
      name: ws.name,
      description: ws.description,
      icon: ws.icon,
      slug: ws.slug,
      is_public: ws.isPublic,
      my_role: ws.myRole ?? ws.members?.[0]?.role,
      member_count: ws.memberCount ?? ws._count?.members ?? 0,
      channel_count: ws.channelCount ?? ws._count?.channels ?? 0,
      updated_at: ws.updatedAt?.toISOString?.() ?? ws.updatedAt ?? '',
    };
  }

  private toWorkspaceMemberItem(m: any) {
    return {
      id: m.id,
      user_id: m.userId,
      role: m.role,
      joined_at: m.joinedAt?.toISOString?.() ?? m.joinedAt ?? '',
    };
  }

  private toChannelItem(ch: any) {
    return {
      id: ch.id,
      workspace_id: ch.workspaceId,
      name: ch.name,
      description: ch.description,
      topic: ch.topic,
      type: ch.type,
      is_default: ch.isDefault,
      is_archived: ch.isArchived,
      category_id: ch.categoryId,
      member_count: ch.memberCount ?? ch._count?.members ?? 0,
      is_member: ch.isMember ?? false,
    };
  }

  private toCategoryItem(cat: any) {
    return {
      id: cat.id,
      workspace_id: cat.workspaceId,
      name: cat.name,
      position: cat.position,
    };
  }

  start(port: string | number) {
    this.server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, boundPort) => {
        if (err) {
          logger.error(err, 'Failed to start gRPC server');
          return;
        }
        logger.info(`gRPC server running on port ${boundPort}`);
      }
    );
  }
}
