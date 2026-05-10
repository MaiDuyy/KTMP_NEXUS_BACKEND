// services/chat-service/src/lib/userorgClient.ts

const USERORG_SERVICE_URL = process.env.USERORG_SERVICE_URL || 'http://localhost:3011';

export const userorgClient = {
    /**
     * Kiểm tra xem 2 user có phải là bạn bè hay không
     */
    checkFriendship: async (user1Id: string, user2Id: string): Promise<boolean> => {
        try {
            const response = await fetch(
                `${USERORG_SERVICE_URL}/friends/internal/check-friendship?user1Id=${user1Id}&user2Id=${user2Id}`
            );

            if (!response.ok) {
                return false;
            }

            const data = await response.json() as any;
            return !!data.isFriend;
        } catch (error) {
            console.error('[UserOrgClient] Failed to check friendship:', error);
            return false;
        }
    },

    /**
     * Kiểm tra trạng thái chặn giữa 2 user
     */
    checkBlockedStatus: async (user1Id: string, user2Id: string): Promise<boolean> => {
        try {
            const response = await fetch(
                `${USERORG_SERVICE_URL}/friends/internal/check-blocked?user1Id=${user1Id}&user2Id=${user2Id}`
            );

            if (!response.ok) {
                return false;
            }

            const data = await response.json() as any;
            return !!data.isBlocked;
        } catch (error) {
            console.error('[UserOrgClient] Failed to check blocked status:', error);
            return false;
        }
    }
};
