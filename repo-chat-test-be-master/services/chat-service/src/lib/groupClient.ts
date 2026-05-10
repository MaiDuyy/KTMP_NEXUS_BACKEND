import { internalFetch } from '@ott/shared';

const GROUP_SERVICE_URL = process.env.GROUP_SERVICE_URL || 'http://localhost:3012';

export const groupChatClient = {
  /**
   * Lấy metadata chat (internal)
   */
  getChatMetadataInternal: async (chatId: string) => {
    try {
      const response = await fetch(`${GROUP_SERVICE_URL}/chats/internal/${chatId}/metadata`);
      if (!response.ok) return null;
      const data = await response.json() as any;
      return data.chat;
    } catch (error) {
      console.error('[groupChatClient] getChatMetadataInternal error:', error);
      return null;
    }
  },

  /**
   * Lấy danh sách participant IDs (internal)
   */
  getParticipantIdsInternal: async (chatId: string) => {
    try {
      const response = await fetch(`${GROUP_SERVICE_URL}/chats/internal/${chatId}/participant-ids`);
      if (!response.ok) return [];
      const data = await response.json() as any;
      return data.participantIds || [];
    } catch (error) {
      console.error('[groupChatClient] getParticipantIdsInternal error:', error);
      return [];
    }
  }
};
