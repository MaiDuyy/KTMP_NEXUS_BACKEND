// services/file-service/src/providers/cloudinary.provider.ts
// Cloudinary storage provider implementation

import { v2 as cloudinary } from 'cloudinary';
import { StorageProvider, UploadOptions, UploadResult } from './storage.interface.js';
import { logger } from '../lib/logger.js';

export class CloudinaryProvider implements StorageProvider {
  name = 'cloudinary';

  constructor() {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  async upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: options.folder,
          public_id: options.publicId,
          resource_type: options.resourceType || 'auto',
          transformation: options.transformation,
        },
        (error, result) => {
          if (error) {
            logger.error({ error: error.message }, 'Cloudinary upload failed');
            reject(error);
          } else if (result) {
            resolve({
              url: result.secure_url,
              publicId: result.public_id,
              size: result.bytes,
              mimeType: options.mimeType || `${result.resource_type}/${result.format}`,
              format: result.format,
            });
          }
        }
      );
      uploadStream.end(buffer);
    });
  }

  async delete(publicId: string, resourceType = 'image'): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
      logger.info({ publicId }, 'Cloudinary file deleted');
    } catch (error: any) {
      logger.error({ error: error.message, publicId }, 'Cloudinary delete failed');
      throw error;
    }
  }
}
