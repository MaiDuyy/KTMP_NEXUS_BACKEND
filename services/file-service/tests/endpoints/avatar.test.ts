// tests/endpoints/avatar.test.ts
// Avatar upload endpoint tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { mockPrisma, mockStorageProvider } from '../setup.js';

// Create test app for avatar endpoint
function createAvatarTestApp() {
  const app = express();
  app.use(express.json());

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

  app.post('/avatar', upload.single('file'), async (req, res) => {
    try {
      const userId = req.headers['x-user-id'] as string;

      if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn file ảnh!' });
      }

      if (!ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Chỉ chấp nhận file ảnh (jpg, jpeg, png, gif, webp)!',
        });
      }

      const uploadResult = await mockStorageProvider.upload(req.file.buffer, {
        folder: 'chat-app/avatars',
        publicId: `avatar_${userId}_${Date.now()}`,
        resourceType: 'image',
        mimeType: req.file.mimetype,
      });

      await mockPrisma.file.create({
        data: {
          id: 'test-file-id',
          userId,
          type: 'AVATAR',
          mimeType: req.file.mimetype,
          url: uploadResult.url,
          publicId: uploadResult.publicId,
          size: req.file.size,
        },
      });

      res.json({
        success: true,
        message: 'Upload avatar thành công!',
        url: uploadResult.url,
        publicId: uploadResult.publicId,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, message: 'Lỗi upload avatar!' });
    }
  });

  return app;
}

describe('Avatar Upload Endpoint', () => {
  const app = createAvatarTestApp();

  beforeEach(() => {
    mockStorageProvider.upload.mockResolvedValue({
      url: 'https://mock-storage.com/avatar.webp',
      publicId: 'chat-app/avatars/avatar_user123_123456789',
      size: 2048,
      mimeType: 'image/webp',
    });

    mockPrisma.file.create.mockResolvedValue({
      id: 'test-file-id',
      userId: 'user123',
      type: 'AVATAR',
      url: 'https://mock-storage.com/avatar.webp',
    });
  });

  describe('POST /avatar', () => {
    it('should upload avatar successfully with valid image', async () => {
      // Arrange
      const testImage = Buffer.from('fake-image-data');

      // Act
      const response = await request(app)
        .post('/avatar')
        .set('x-user-id', 'user123')
        .attach('file', testImage, { filename: 'avatar.jpg', contentType: 'image/jpeg' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.url).toBeDefined();
      expect(response.body.publicId).toBeDefined();
      expect(mockStorageProvider.upload).toHaveBeenCalled();
      expect(mockPrisma.file.create).toHaveBeenCalled();
    });

    it('should reject request without x-user-id header', async () => {
      // Arrange
      const testImage = Buffer.from('fake-image-data');

      // Act
      const response = await request(app)
        .post('/avatar')
        .attach('file', testImage, { filename: 'avatar.jpg', contentType: 'image/jpeg' });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Chưa đăng nhập!');
    });

    it('should reject request without file', async () => {
      // Act
      const response = await request(app)
        .post('/avatar')
        .set('x-user-id', 'user123');

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Vui lòng chọn file ảnh!');
    });

    it('should reject non-image file types', async () => {
      // Arrange
      const testFile = Buffer.from('fake-pdf-data');

      // Act
      const response = await request(app)
        .post('/avatar')
        .set('x-user-id', 'user123')
        .attach('file', testFile, { filename: 'document.pdf', contentType: 'application/pdf' });

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Chỉ chấp nhận file ảnh');
    });

    it('should handle storage upload errors', async () => {
      // Arrange
      mockStorageProvider.upload.mockRejectedValueOnce(new Error('Storage error'));
      const testImage = Buffer.from('fake-image-data');

      // Act
      const response = await request(app)
        .post('/avatar')
        .set('x-user-id', 'user123')
        .attach('file', testImage, { filename: 'avatar.jpg', contentType: 'image/jpeg' });

      // Assert
      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });
});
