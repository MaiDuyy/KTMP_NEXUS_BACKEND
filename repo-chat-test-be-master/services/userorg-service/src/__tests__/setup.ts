// Test setup - Mock external dependencies

// import { jest } from '@jest/globals';

// Mock Prisma
export const mockPrisma = {
  account: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  invitation: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  orgSettings: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $disconnect: jest.fn(),
};

jest.mock('../lib/prisma.js', () => ({
  prisma: mockPrisma,
}));


// Mock NATS
export const mockPublishEvent = jest.fn(async () => undefined);
export const mockConnectNats = jest.fn(async () => undefined);
export const mockDisconnectNats = jest.fn(async () => undefined);

jest.mock('../lib/nats.js', () => ({
  publishEvent: mockPublishEvent,
  connectNats: mockConnectNats,
  disconnectNats: mockDisconnectNats,
  EventSubjects: {
    USER_UPDATED: 'user.updated',
    USER_SUSPENDED: 'user.suspended',
    USER_UNSUSPENDED: 'user.unsuspended',
    USER_DELETED: 'user.deleted',
    INVITATION_CREATED: 'invitation.created',
    INVITATION_ACCEPTED: 'invitation.accepted',
    ORG_SETTINGS_UPDATED: 'org.settings.updated',
  },
}));

// Mock Logger

export const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../lib/logger.js', () => ({
  logger: mockLogger,
}));
// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

