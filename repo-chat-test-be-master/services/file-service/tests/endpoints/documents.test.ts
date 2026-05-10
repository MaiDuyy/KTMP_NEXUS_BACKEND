// tests/endpoints/documents.test.ts
// RAG Document upload endpoint tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { mockPrisma, mockStorageProvider } from '../setup.js';

// Create test app for document endpoint
function createDocumentTestApp() {
  const app = express();
  app.use(express.json());

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  const ALLOWED_DOCUMENT_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
  ];

  const VALID_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

  app.post('/documents', upload.single('file'), async (req, res) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      const { classification, department, project, tags, collectionId } = req.body;

      if (!userId) {
        return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn file tài liệu!' });
      }

      if (!ALLOWED_DOCUMENT_TYPES.includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Chỉ chấp nhận file PDF, DOCX, hoặc TXT!',
        });
      }

      if (classification && !VALID_CLASSIFICATIONS.includes(classification)) {
        return res.status(400).json({
          success: false,
          message: `Classification phải là một trong: ${VALID_CLASSIFICATIONS.join(', ')}`,
        });
      }

      let parsedTags: string[] = [];
      if (tags) {
        parsedTags = typeof tags === 'string' ? tags.split(',').map((t: string) => t.trim()) : tags;
      }

      const uploadResult = await mockStorageProvider.upload(req.file.buffer, {
        folder: 'chat-app/documents',
        publicId: `doc_${userId}_${Date.now()}`,
        resourceType: 'raw',
        mimeType: req.file.mimetype,
      });

      const file = await mockPrisma.file.create({
        data: {
          id: 'test-doc-id',
          userId,
          type: 'DOCUMENT',
          mimeType: req.file.mimetype,
          originalName: req.file.originalname,
          url: uploadResult.url,
          publicId: uploadResult.publicId,
          size: req.file.size,
          classification: classification || 'INTERNAL',
          department,
          project,
          tags: parsedTags,
          collectionId,
          processingStatus: 'PENDING',
        },
      });

      res.json({
        success: true,
        message: 'Upload tài liệu thành công!',
        file: {
          id: file.id,
          url: uploadResult.url,
          mimeType: req.file.mimetype,
          originalName: req.file.originalname,
          size: req.file.size,
          classification: file.classification,
          department: file.department,
          project: file.project,
          tags: file.tags,
          processingStatus: file.processingStatus,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, message: 'Lỗi upload tài liệu!' });
    }
  });

  return app;
}

describe('Document Upload Endpoint', () => {
  const app = createDocumentTestApp();

  beforeEach(() => {
    mockStorageProvider.upload.mockResolvedValue({
      url: 'https://mock-storage.com/document.pdf',
      publicId: 'chat-app/documents/doc_user123_123456789',
      size: 102400,
      mimeType: 'application/pdf',
    });

    mockPrisma.file.create.mockResolvedValue({
      id: 'test-doc-id',
      userId: 'user123',
      type: 'DOCUMENT',
      mimeType: 'application/pdf',
      originalName: 'test-document.pdf',
      url: 'https://mock-storage.com/document.pdf',
      publicId: 'chat-app/documents/doc_user123_123456789',
      size: 102400,
      classification: 'INTERNAL',
      department: 'Engineering',
      project: 'RAG System',
      tags: ['api', 'documentation'],
      processingStatus: 'PENDING',
    });
  });

  describe('POST /documents', () => {
    it('should upload PDF document successfully', async () => {
      // Arrange
      const testPdf = Buffer.from('%PDF-1.4 fake pdf content');

      // Act
      const response = await request(app)
        .post('/documents')
        .set('x-user-id', 'user123')
        .field('classification', 'INTERNAL')
        .field('department', 'Engineering')
        .field('tags', 'api,documentation')
        .attach('file', testPdf, { filename: 'test-document.pdf', contentType: 'application/pdf' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.file.mimeType).toBe('application/pdf');
      expect(response.body.file.classification).toBe('INTERNAL');
      expect(response.body.file.processingStatus).toBe('PENDING');
      expect(mockStorageProvider.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          folder: 'chat-app/documents',
          resourceType: 'raw',
        })
      );
    });

    it('should upload TXT document successfully', async () => {
      // Arrange
      const testTxt = Buffer.from('This is a plain text document');
      mockStorageProvider.upload.mockResolvedValueOnce({
        url: 'https://mock-storage.com/document.txt',
        publicId: 'chat-app/documents/doc_user123_123456789',
        size: 1024,
        mimeType: 'text/plain',
      });

      // Act
      const response = await request(app)
        .post('/documents')
        .set('x-user-id', 'user123')
        .attach('file', testTxt, { filename: 'readme.txt', contentType: 'text/plain' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject request without x-user-id header', async () => {
      // Arrange
      const testPdf = Buffer.from('%PDF-1.4 fake pdf content');

      // Act
      const response = await request(app)
        .post('/documents')
        .attach('file', testPdf, { filename: 'test.pdf', contentType: 'application/pdf' });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Chưa đăng nhập!');
    });

    it('should reject request without file', async () => {
      // Act - send as multipart form but without actual file
      const response = await request(app)
        .post('/documents')
        .set('x-user-id', 'user123')
        .set('Content-Type', 'multipart/form-data')
        .field('classification', 'INTERNAL');

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Vui lòng chọn file tài liệu!');
    });

    it('should reject non-document file types (e.g., images)', async () => {
      // Arrange
      const testImage = Buffer.from('fake-image-data');

      // Act
      const response = await request(app)
        .post('/documents')
        .set('x-user-id', 'user123')
        .attach('file', testImage, { filename: 'image.jpg', contentType: 'image/jpeg' });

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Chỉ chấp nhận file PDF, DOCX, hoặc TXT');
    });

    it('should reject invalid classification values', async () => {
      // Arrange
      const testPdf = Buffer.from('%PDF-1.4 fake pdf content');

      // Act
      const response = await request(app)
        .post('/documents')
        .set('x-user-id', 'user123')
        .field('classification', 'INVALID_LEVEL')
        .attach('file', testPdf, { filename: 'test.pdf', contentType: 'application/pdf' });

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Classification phải là một trong');
    });

    it('should default classification to INTERNAL when not provided', async () => {
      // Arrange
      const testPdf = Buffer.from('%PDF-1.4 fake pdf content');

      // Act
      const response = await request(app)
        .post('/documents')
        .set('x-user-id', 'user123')
        .attach('file', testPdf, { filename: 'test.pdf', contentType: 'application/pdf' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.file.classification).toBe('INTERNAL');
    });

    it('should parse comma-separated tags correctly', async () => {
      // Arrange
      const testPdf = Buffer.from('%PDF-1.4 fake pdf content');

      // Act
      const response = await request(app)
        .post('/documents')
        .set('x-user-id', 'user123')
        .field('tags', 'api, guide, internal')
        .attach('file', testPdf, { filename: 'test.pdf', contentType: 'application/pdf' });

      // Assert
      expect(response.status).toBe(200);
      expect(mockPrisma.file.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tags: ['api', 'guide', 'internal'],
          }),
        })
      );
    });

    it('should handle storage upload errors gracefully', async () => {
      // Arrange
      mockStorageProvider.upload.mockRejectedValueOnce(new Error('Storage unavailable'));
      const testPdf = Buffer.from('%PDF-1.4 fake pdf content');

      // Act
      const response = await request(app)
        .post('/documents')
        .set('x-user-id', 'user123')
        .attach('file', testPdf, { filename: 'test.pdf', contentType: 'application/pdf' });

      // Assert
      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Lỗi upload tài liệu!');
    });
  });
});
