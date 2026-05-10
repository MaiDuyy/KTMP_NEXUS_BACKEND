// Test setup - Mock all external dependencies
// Using manual mocks for ESM compatibility

// Mock data
export const mockPrisma = {
  account: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  loggedInDevice: {
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  otp: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
};

export const mockRbacClient = {
  assignRole: jest.fn().mockResolvedValue(true),
  getUserPermissions: jest.fn().mockResolvedValue({
    userId: 'test-id',
    roles: ['EMPLOYEE'],
    roleLevel: 10,
    departments: [],
    groups: [],
    permissions: [],
  }),
  checkPermission: jest.fn().mockResolvedValue(true),
  hasRole: jest.fn().mockResolvedValue(true),
  isHealthy: jest.fn().mockResolvedValue(true),
};

export const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

export const mockPublishEvent = jest.fn().mockResolvedValue(undefined);

// Global mock implementations
jest.mock('../lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

jest.mock('../lib/nats.js', () => ({
  publishEvent: mockPublishEvent,
  EventSubjects: {
    USER_CREATED: 'user.created',
    USER_ONLINE: 'user.online',
    USER_OFFLINE: 'user.offline',
    OTP_SEND: 'otp.send',
  },
}));

jest.mock('../lib/rbac-client.js', () => ({
  rbacClient: mockRbacClient,
  UserPermissions: {},
}));

jest.mock('../lib/logger.js', () => ({
  logger: mockLogger,
}));

jest.mock('../../../../config/auth.config.js', () => ({
  authConfig: {
    secret: 'test-secret-key-for-jwt-testing-12345',
    accessTokenExpiry: '1h',
    refreshTokenExpiry: '7d',
  },
}));

// RBAC SystemRole types for testing
export type SystemRole = 'SUPER_ADMIN' | 'ORG_ADMIN' | 'SECURITY_OFFICER' | 'WORKSPACE_MANAGER' | 'KNOWLEDGE_ADMIN' | 'AI_ADMIN' | 'EMPLOYEE' | 'GUEST';

// AccountRole for auth-service legacy
export type AccountRole = 'USER' | 'ADMIN' | 'MODERATOR';

// Test utilities
export const createMockUser = (overrides: Record<string, any> = {}) => ({
  id: 'user-123',
  name: 'Test User',
  email: 'test@example.com',
  number: '0123456789',
  password: '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', // "password"
  avatar: null,
  gender: 'male',
  birthDate: null,
  location: null,
  role: 'USER' as AccountRole,
  isVerified: true,
  isOnline: false,
  lastSeen: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// EMPLOYEE role user (RBAC)
export const createMockEmployee = (overrides: Record<string, any> = {}) =>
  createMockUser({ 
    id: 'employee-123', 
    email: 'employee@company.com',
    ...overrides 
  });

// SUPER_ADMIN role user
export const createMockSuperAdmin = (overrides: Record<string, any> = {}) =>
  createMockUser({ 
    id: 'admin-123', 
    role: 'ADMIN' as AccountRole,
    email: 'admin@company.com',
    ...overrides 
  });

// WORKSPACE_MANAGER role user
export const createMockWorkspaceManager = (overrides: Record<string, any> = {}) =>
  createMockUser({ 
    id: 'manager-123', 
    role: 'MODERATOR' as AccountRole,
    email: 'manager@company.com',
    ...overrides 
  });

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});
