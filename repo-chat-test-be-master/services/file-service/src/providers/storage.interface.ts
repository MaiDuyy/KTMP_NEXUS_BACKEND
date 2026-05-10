// services/file-service/src/providers/storage.interface.ts
// Storage provider abstraction for multi-cloud support

export interface UploadOptions {
  folder: string;
  publicId: string;
  resourceType?: 'image' | 'video' | 'raw' | 'auto';
  transformation?: Record<string, any>[];
  mimeType?: string;
}

export interface UploadResult {
  url: string;
  publicId: string;
  size: number;
  mimeType: string;
  format?: string;
}

export interface StorageProvider {
  name: string;
  
  /**
   * Upload a file buffer to storage
   */
  upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult>;
  
  /**
   * Delete a file from storage
   */
  delete(publicId: string, resourceType?: string): Promise<void>;
  
  /**
   * Get a signed URL for private files (optional)
   */
  getSignedUrl?(publicId: string, expiresIn?: number): Promise<string>;
}

export type StorageProviderType = 'cloudinary' | 's3';
