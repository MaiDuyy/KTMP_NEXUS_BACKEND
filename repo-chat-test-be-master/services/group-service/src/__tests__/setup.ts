import { jest, beforeEach } from '@jest/globals';
import { mockPrisma, mockPublishEvent, mockConnectNats, mockDisconnectNats, mockLogger } from './mocks.js';

// Test setup - Mock external dependencies for group-service
// Using jest.unstable_mockModule for ESM compatibility

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

jest.unstable_mockModule('../lib/nats.js', () => ({
  publishEvent: mockPublishEvent,
  connectNats: mockConnectNats,
  disconnectNats: mockDisconnectNats,
  EventSubjects: {
    GROUP_CREATED: 'group.created',
    GROUP_UPDATED: 'group.updated',
    GROUP_DELETED: 'group.deleted',
    GROUP_MEMBER_ADDED: 'group.member.added',
    GROUP_MEMBER_REMOVED: 'group.member.removed',
    MESSAGE_READ: 'message.read',
    WORKSPACE_CREATED: 'workspace.created',
    WORKSPACE_UPDATED: 'workspace.updated',
    WORKSPACE_DELETED: 'workspace.deleted',
    WORKSPACE_MEMBER_ADDED: 'workspace.member.added',
    WORKSPACE_MEMBER_REMOVED: 'workspace.member.removed',
    CHANNEL_CREATED: 'channel.created',
    CHANNEL_UPDATED: 'channel.updated',
    CHANNEL_DELETED: 'channel.deleted',
    CHANNEL_ARCHIVED: 'channel.archived',
    CHANNEL_MEMBER_ADDED: 'channel.member.added',
    CHANNEL_MEMBER_REMOVED: 'channel.member.removed',
  },
}));

jest.unstable_mockModule('../lib/logger.js', () => ({
  logger: mockLogger,
}));

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});
