import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { collectionService } from '../services/collection.service.js';
import { documentService } from '../services/document.service.js';
import { aclService } from '../services/acl.service.js';
import { processingService } from '../services/processing.service.js';
import { createError } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';

const router = Router();

// File upload configuration
const uploadDir = process.env.UPLOAD_DIR || './uploads';
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800') }, // 50MB default
});

// ==================== COLLECTION ENDPOINTS ====================

// GET /collections - List all collections
router.get('/collections', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const collections = await collectionService.getCollections({ includeDocumentCount: true });
    res.json({ success: true, data: collections });
  } catch (error) {
    next(error);
  }
});

// GET /collections/:id - Get collection by ID
router.get('/collections/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const collection = await collectionService.getCollectionById(req.params.id);
    if (!collection) {
      throw createError('Collection not found', 404, 'COLLECTION_NOT_FOUND');
    }
    res.json({ success: true, data: collection });
  } catch (error) {
    next(error);
  }
});

// POST /collections - Create collection
const createCollectionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  ownerId: z.string().uuid(),
  defaultClassification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'TOP_SECRET']).optional(),
  isAIEnabled: z.boolean().optional(),
  ragPriority: z.number().int().min(1).max(10).optional(),
});

router.post('/collections', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createCollectionSchema.parse(req.body);
    const collection = await collectionService.createCollection(data);
    res.status(201).json({ success: true, data: collection });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// PUT /collections/:id - Update collection
router.put('/collections/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createCollectionSchema.partial().parse(req.body);
    const collection = await collectionService.updateCollection(req.params.id, data);
    res.json({ success: true, data: collection });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /collections/:id - Delete collection
router.delete('/collections/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await collectionService.deleteCollection(req.params.id);
    res.json({ success: true, message: 'Collection deleted' });
  } catch (error) {
    next(error);
  }
});

// ==================== COLLECTION ACL ENDPOINTS ====================

// GET /collections/:id/acl - Get collection ACL
router.get('/collections/:id/acl', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const acl = await aclService.getCollectionACL(req.params.id);
    res.json({ success: true, data: acl });
  } catch (error) {
    next(error);
  }
});

// POST /collections/:id/acl - Grant collection access
const grantAccessSchema = z.object({
  userId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  roleId: z.string().uuid().optional(),
  canRead: z.boolean().optional(),
  canWrite: z.boolean().optional(),
  canDelete: z.boolean().optional(),
  canAdmin: z.boolean().optional(),
  grantedBy: z.string().uuid(),
  expiresAt: z.string().datetime().optional(),
});

router.post('/collections/:id/acl', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { grantedBy, expiresAt, ...entry } = grantAccessSchema.parse(req.body);
    await aclService.grantCollectionAccess(
      req.params.id,
      { ...entry, expiresAt: expiresAt ? new Date(expiresAt) : undefined },
      grantedBy
    );
    res.status(201).json({ success: true, message: 'Access granted' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /collections/:id/acl - Revoke collection access
const revokeAccessSchema = z.object({
  userId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  roleId: z.string().uuid().optional(),
});

router.delete('/collections/:id/acl', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entry = revokeAccessSchema.parse(req.body);
    await aclService.revokeCollectionAccess(req.params.id, entry);
    res.json({ success: true, message: 'Access revoked' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// ==================== DOCUMENT ENDPOINTS ====================

// GET /collections/:collectionId/documents - List documents in collection
router.get('/collections/:collectionId/documents', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const documents = await documentService.getDocuments(req.params.collectionId, {
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json({ success: true, data: documents });
  } catch (error) {
    next(error);
  }
});

// GET /documents/:id - Get document by ID
router.get('/documents/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const document = await documentService.getDocumentById(req.params.id);
    if (!document) {
      throw createError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    res.json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
});

// POST /collections/:collectionId/documents - Upload document
router.post(
  '/collections/:collectionId/documents',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw createError('No file uploaded', 400, 'NO_FILE');
      }

      const { title, description, classification, uploadedBy } = req.body;
      
      if (!uploadedBy) {
        throw createError('uploadedBy is required', 400, 'VALIDATION_ERROR');
      }

      const document = await documentService.createDocument({
        collectionId: req.params.collectionId,
        title: title || req.file.originalname,
        description,
        fileName: req.file.originalname,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        filePath: req.file.path,
        classification,
        uploadedBy,
      });

      // Start processing asynchronously
      processingService.processDocument(document.id).catch(err => {
        logger.error({ err, documentId: document.id }, 'Async processing failed');
      });

      res.status(201).json({ success: true, data: document });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /documents/:id - Update document metadata
const updateDocumentSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'TOP_SECRET']).optional(),
});

router.put('/documents/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateDocumentSchema.parse(req.body);
    const document = await documentService.updateDocument(req.params.id, data);
    res.json({ success: true, data: document });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// DELETE /documents/:id - Delete document
router.delete('/documents/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await documentService.deleteDocument(req.params.id);
    res.json({ success: true, message: 'Document deleted' });
  } catch (error) {
    next(error);
  }
});

// POST /documents/:id/reindex - Reindex document
router.post('/documents/:id/reindex', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const success = await processingService.reindexDocument(req.params.id);
    res.json({ success, message: success ? 'Reindexing started' : 'Reindex failed' });
  } catch (error) {
    next(error);
  }
});

// GET /documents/:id/chunks - Get document chunks
router.get('/documents/:id/chunks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chunks = await documentService.getChunks(req.params.id);
    res.json({ success: true, data: chunks });
  } catch (error) {
    next(error);
  }
});

// ==================== SEARCH ENDPOINTS ====================

// GET /search - Search documents
router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, collections, limit } = req.query;
    if (!q) {
      throw createError('Query parameter "q" is required', 400, 'VALIDATION_ERROR');
    }

    const documents = await documentService.searchDocuments(q as string, {
      collectionIds: collections ? (collections as string).split(',') : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });

    res.json({ success: true, data: documents });
  } catch (error) {
    next(error);
  }
});

// ==================== ACCESS CHECK ENDPOINTS ====================

// POST /access/check - Check if user has access to document
const accessCheckSchema = z.object({
  documentId: z.string().uuid(),
  userId: z.string().uuid(),
  departments: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  permission: z.enum(['read', 'write']).optional(),
});

router.post('/access/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { documentId, userId, departments = [], groups = [], permission = 'read' } = accessCheckSchema.parse(req.body);
    
    const hasAccess = await aclService.hasDocumentAccess(
      documentId,
      userId,
      departments,
      groups,
      permission
    );

    res.json({ success: true, data: { hasAccess, documentId, userId, permission } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

// POST /access/documents - Get accessible documents for user
const accessibleDocsSchema = z.object({
  userId: z.string().uuid(),
  departments: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  collectionIds: z.array(z.string().uuid()).optional(),
});

router.post('/access/documents', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, departments = [], groups = [], collectionIds } = accessibleDocsSchema.parse(req.body);
    
    const documentIds = await aclService.getAccessibleDocuments(
      userId,
      departments,
      groups,
      collectionIds
    );

    res.json({ success: true, data: { userId, documentIds, count: documentIds.length } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.message, 400, 'VALIDATION_ERROR'));
    }
    next(error);
  }
});

export { router as knowledgeRoutes };
