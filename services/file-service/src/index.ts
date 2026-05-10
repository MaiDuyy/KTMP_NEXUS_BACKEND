// services/file-service/src/index.ts
// File Service - Upload và quản lý files với storage provider abstraction

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { publishEvent, connectNats, disconnectNats, EventSubjects } from './lib/nats.js';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { getStorageProvider } from './providers/index.js';
import { internalAuthMiddleware } from '@ott/shared';

const app = express();
const PORT = process.env.PORT || 3014;

// Storage provider (Cloudinary or S3)
const storage = getStorageProvider();

// Multer config
const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760') }, // 10MB default
});

const documentUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: parseInt(process.env.MAX_DOCUMENT_SIZE || '52428800') }, // 50MB for documents
});

// Allowed types
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_FILE_TYPES = [...ALLOWED_IMAGE_TYPES, 'application/pdf', 'video/mp4', 'audio/mpeg'];
const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
];

// Classification options
const VALID_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

// Internal service behind API Gateway — permissive CORS to avoid conflicts
// with the gateway's own CORS policy when headers are proxied back.
app.use(cors());
app.use(express.json());
// ============= HEALTH CHECK =============

const healthHandler = async (_req: any, res: any) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      service: 'file-service',
      database: 'connected',
      storageProvider: storage.name,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ status: 'error', service: 'file-service', database: 'disconnected' });
  }
};

// Support both /healthz (Docker HEALTHCHECK) and /upload/healthz (gateway proxy)
app.get('/healthz', healthHandler);
app.get('/upload/healthz', healthHandler);

// ============= STATISTICS =============
app.get('/stats', async (_req, res) => {
  try {
    const [totalFiles, totalSize] = await Promise.all([
      prisma.file.count(),
      prisma.file.aggregate({
        _sum: { size: true }
      })
    ]);

    res.json({
      success: true,
      totalFiles,
      totalSize: totalSize._sum.size || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'File stats error');
    res.status(500).json({ success: false, message: 'Lỗi lấy thống kê file!' });
  }
});

// ============= UPLOAD AVATAR =============
// app.use(internalAuthMiddleware);

app.post('/upload/avatar', upload.single('file'), async (req, res) => {
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

    // Upload via storage provider
    const uploadResult = await storage.upload(req.file.buffer, {
      folder: 'chat-app/avatars',
      publicId: `avatar_${userId}_${Date.now()}`,
      resourceType: 'image',
      mimeType: req.file.mimetype,
      transformation: [
        { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        { quality: 'auto', format: 'webp' },
      ],
    });

    // Save to database
    await prisma.file.create({
      data: {
        id: uuidv4(),
        userId,
        type: 'AVATAR',
        mimeType: req.file.mimetype,
        url: uploadResult.url,
        publicId: uploadResult.publicId,
        size: req.file.size,
      },
    });

    // Publish event
    await publishEvent(EventSubjects.FILE_UPLOADED, {
      userId,
      type: 'AVATAR',
      url: uploadResult.url,
    });

    res.json({
      success: true,
      message: 'Upload avatar thành công!',
      url: uploadResult.url,
      publicId: uploadResult.publicId,
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Upload avatar error');
    res.status(500).json({ success: false, message: 'Lỗi upload avatar!' });
  }
});

// ============= UPLOAD CHAT FILE =============

app.post('/upload/chat', upload.single('file'), async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const { chatId } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Vui lòng chọn file!' });
    }

    if (!ALLOWED_FILE_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Loại file không được hỗ trợ!' });
    }

    // Determine resource type
    let resourceType: 'image' | 'video' | 'raw' = 'raw';
    if (ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)) resourceType = 'image';
    else if (req.file.mimetype.startsWith('video/')) resourceType = 'video';

    // Upload via storage provider
    const uploadResult = await storage.upload(req.file.buffer, {
      folder: 'chat-app/chat-files',
      publicId: `file_${userId}_${Date.now()}`,
      resourceType,
      mimeType: req.file.mimetype,
    });

    // Save to database
    const file = await prisma.file.create({
      data: {
        id: uuidv4(),
        userId,
        chatId,
        type: 'CHAT',
        mimeType: req.file.mimetype,
        originalName: req.file.originalname,
        url: uploadResult.url,
        publicId: uploadResult.publicId,
        size: req.file.size,
      },
    });

    await publishEvent(EventSubjects.CHAT_FILE_UPLOADED, {
  fileId: file.id,
  chatId,
  userId,
  url: uploadResult.url,
  mimeType: req.file.mimetype,
  originalName: req.file.originalname,
  size: req.file.size,
});

    res.json({
      success: true,
      message: 'Upload file thành công!',
      file: {
        id: file.id,
        url: uploadResult.url,
        mimeType: req.file.mimetype,
        originalName: req.file.originalname,
        size: req.file.size,
      },
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Upload chat file error');
    res.status(500).json({ success: false, message: 'Lỗi upload file!' });
  }
});

// ============= UPLOAD RAG DOCUMENT =============

app.post('/upload/documents', documentUpload.single('file'), async (req, res) => {
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

    // Validate classification if provided
    if (classification && !VALID_CLASSIFICATIONS.includes(classification)) {
      return res.status(400).json({
        success: false,
        message: `Classification phải là một trong: ${VALID_CLASSIFICATIONS.join(', ')}`,
      });
    }

    // Parse tags if string
    let parsedTags: string[] = [];
    if (tags) {
      parsedTags = typeof tags === 'string' ? tags.split(',').map((t: string) => t.trim()) : tags;
    }

    // Upload via storage provider
    const uploadResult = await storage.upload(req.file.buffer, {
      folder: 'chat-app/documents',
      publicId: `doc_${userId}_${Date.now()}`,
      resourceType: 'raw',
      mimeType: req.file.mimetype,
    });

    // Save to database
    const file = await prisma.file.create({
      data: {
        id: uuidv4(),
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

    // Publish event for async processing (if job queue enabled)
    if (process.env.ENABLE_JOB_QUEUE === 'true') {
      await publishEvent(EventSubjects.DOCUMENT_UPLOADED, {
        fileId: file.id,
        userId,
        url: uploadResult.url,
        mimeType: req.file.mimetype,
        classification: classification || 'INTERNAL',
        collectionId,
      });
      logger.info({ fileId: file.id }, 'Document upload event published for processing');
    }

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
    logger.error({ error: error.message }, 'Upload document error');
    res.status(500).json({ success: false, message: 'Lỗi upload tài liệu!' });
  }
});

// ============= GET DOCUMENTS =============

app.get('/upload/documents', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const { classification, department, status, limit = 20, cursor, collectionId } = req.query;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    const where: any = { type: 'DOCUMENT' };
    
    // Filter by owner or accessible collections (simplified - full ACL in knowledge-service)
    where.OR = [
      { userId },
      { classification: 'PUBLIC' },
    ];

    if (classification) where.classification = classification;
    if (department) where.department = department;
    if (status) where.processingStatus = status;
    if (collectionId) where.collectionId = collectionId;
    if (cursor) where.createdAt = { lt: new Date(cursor as string) };

    const documents = await prisma.file.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json({
      success: true,
      documents: documents.map((d) => ({
        id: d.id,
        originalName: d.originalName,
        url: d.url,
        mimeType: d.mimeType,
        size: d.size,
        classification: d.classification,
        department: d.department,
        project: d.project,
        tags: d.tags,
        processingStatus: d.processingStatus,
        createdAt: d.createdAt,
      })),
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Get documents error');
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách tài liệu!' });
  }
});

// ============= DELETE FILE =============

app.delete('/upload/:fileId', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const { fileId } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Chưa đăng nhập!' });
    }

    const file = await prisma.file.findUnique({ where: { id: fileId } });

    if (!file) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy file!' });
    }

    if (file.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Không có quyền xóa file này!' });
    }

    // Delete from storage
    if (file.publicId) {
      const resourceType = file.type === 'DOCUMENT' ? 'raw' : 
                          ALLOWED_IMAGE_TYPES.includes(file.mimeType) ? 'image' : 'raw';
      await storage.delete(file.publicId, resourceType);
    }

    // Delete from database
    await prisma.file.delete({ where: { id: fileId } });

    res.json({ success: true, message: 'Xóa file thành công!' });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Delete file error');
    res.status(500).json({ success: false, message: 'Lỗi xóa file!' });
  }
});

// ============= GET USER FILES =============

app.get('/upload/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { type, limit = 20, cursor } = req.query;

    const where: any = { userId };
    if (type) where.type = type;
    if (cursor) where.createdAt = { lt: new Date(cursor as string) };

    const files = await prisma.file.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json({
      success: true,
      files: files.map((f) => ({
        id: f.id,
        type: f.type,
        url: f.url,
        mimeType: f.mimeType,
        originalName: f.originalName,
        size: f.size,
        createdAt: f.createdAt,
      })),
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Get user files error');
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách files!' });
  }
});

// ============= 404 FALLBACK =============

app.use((req, res) => {
  logger.warn({ method: req.method, path: req.path, url: req.originalUrl }, 'File Service: Route not found');
  res.status(404).json({
    success: false,
    message: `File Service: ${req.method} ${req.path} not found`,
    hint: req.method === 'GET' && ['/upload/chat', '/upload/avatar'].includes(req.path)
      ? 'This endpoint only accepts POST requests with multipart/form-data'
      : undefined,
  });
});

// ============= GRACEFUL SHUTDOWN =============

async function shutdown() {
  logger.info('Shutting down file-service...');
  await disconnectNats();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ============= START =============

async function start() {
  try {
    await connectNats().catch((e) => logger.warn({ error: e.message }, 'NATS not available'));

    app.listen(PORT, () => {
      logger.info(`File Service running on port ${PORT} (provider: ${storage.name})`);
    });
  } catch (error) {
    logger.error(error, 'Failed to start file-service');
    process.exit(1);
  }
}

start();
