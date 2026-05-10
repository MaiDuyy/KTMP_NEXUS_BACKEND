// services/file-service/src/providers/s3.provider.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageProvider, UploadOptions, UploadResult } from './storage.interface.js';
import { logger } from '../lib/logger.js';

export class S3Provider implements StorageProvider {
  name = 's3';
  private client: S3Client;
  private bucket: string;
  private cloudfrontDomain: string | null;

  constructor() {
    this.bucket = process.env.AWS_S3_BUCKET || '';
    this.cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN || null; // ví dụ: "https://d123.cloudfront.net"

    this.client = new S3Client({
      region: process.env.AWS_REGION || 'ap-southeast-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });
  }

  async upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult> {
    const key = `${options.folder}/${options.publicId}`;

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: options.mimeType,
      }));

      // Xây dựng URL: ưu tiên CloudFront nếu có, không thì dùng S3 endpoint
      let url: string;
      if (this.cloudfrontDomain) {
        url = `${this.cloudfrontDomain}/${key}`;
      } else {
        url = `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
      }

      logger.info({ key, bucket: this.bucket, cloudfront: !!this.cloudfrontDomain }, 'S3 upload successful');

      return {
        url,
        publicId: key,
        size: buffer.length,
        mimeType: options.mimeType || 'application/octet-stream',
      };
    } catch (error: any) {
      logger.error({ error: error.message, key }, 'S3 upload failed');
      throw error;
    }
  }

  async delete(publicId: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: publicId,
      }));
      logger.info({ publicId }, 'S3 file deleted');
    } catch (error: any) {
      logger.error({ error: error.message, publicId }, 'S3 delete failed');
      throw error;
    }
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }
}