// services/file-service/src/providers/index.ts
// Storage provider factory

import { StorageProvider, StorageProviderType } from './storage.interface.js';
import { CloudinaryProvider } from './cloudinary.provider.js';
import { S3Provider } from './s3.provider.js';
import { logger } from '../lib/logger.js';

let storageProvider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (storageProvider) {
    return storageProvider;
  }

  const providerType = (process.env.STORAGE_PROVIDER || 'cloudinary') as StorageProviderType;

  switch (providerType) {
    case 's3':
      if (!process.env.AWS_S3_BUCKET || !process.env.AWS_ACCESS_KEY_ID) {
        logger.warn('S3 credentials not configured, falling back to Cloudinary');
        storageProvider = new CloudinaryProvider();
      } else {
        storageProvider = new S3Provider();
      }
      break;
    case 'cloudinary':
    default:
      storageProvider = new CloudinaryProvider();
      break;
  }

  logger.info({ provider: storageProvider.name }, 'Storage provider initialized');
  return storageProvider;
}

export * from './storage.interface.js';
export { CloudinaryProvider } from './cloudinary.provider.js';
export { S3Provider } from './s3.provider.js';
