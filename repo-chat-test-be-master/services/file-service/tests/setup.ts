// tests/setup.ts
// Test setup and mocks for file-service

import { vi } from 'vitest';

// Mock Prisma
export const mockPrisma = {
  file: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
  $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
  $disconnect: vi.fn(),
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

// Mock NATS
vi.mock('../src/lib/nats.js', () => ({
  connectNats: vi.fn().mockResolvedValue({}),
  disconnectNats: vi.fn().mockResolvedValue(undefined),
  publishEvent: vi.fn().mockResolvedValue(undefined),
  EventSubjects: {
    FILE_UPLOADED: 'file.uploaded',
    FILE_DELETED: 'file.deleted',
    DOCUMENT_UPLOADED: 'file.document.uploaded',
  },
}));

// Mock Storage Provider
export const mockStorageProvider = {
  name: 'mock',
  upload: vi.fn().mockResolvedValue({
    url: 'https://mock-storage.com/test-file.jpg',
    publicId: 'mock_public_id_123',
    size: 1024,
    mimeType: 'image/jpeg',
  }),
  delete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../src/providers/index.js', () => ({
  getStorageProvider: vi.fn(() => mockStorageProvider),
}));

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});
