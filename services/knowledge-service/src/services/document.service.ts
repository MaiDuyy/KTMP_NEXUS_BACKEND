import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent, KnowledgeEventSubjects } from '../lib/nats.js';
import type { Document, DocumentStatus, Classification } from '@prisma/client';

export class DocumentService {
  // Get documents in a collection
  async getDocuments(collectionId: string, options?: {
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }): Promise<Document[]> {
    return prisma.document.findMany({
      where: {
        collectionId,
        status: options?.status,
      },
      take: options?.limit || 50,
      skip: options?.offset || 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Get document by ID
  async getDocumentById(id: string): Promise<Document | null> {
    return prisma.document.findUnique({
      where: { id },
      include: {
        chunks: true,
        acl: true,
        collection: { select: { name: true, defaultClassification: true } },
      },
    });
  }

  // Create document metadata (after file upload)
  async createDocument(data: {
    collectionId: string;
    title: string;
    description?: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    filePath: string;
    fileHash?: string;
    sourceType?: string;
    sourceUrl?: string;
    classification?: Classification;
    uploadedBy: string;
  }): Promise<Document> {
    // Get collection for default classification
    const collection = await prisma.collection.findUnique({
      where: { id: data.collectionId },
      select: { defaultClassification: true },
    });

    const document = await prisma.document.create({
      data: {
        collectionId: data.collectionId,
        title: data.title,
        description: data.description,
        fileName: data.fileName,
        fileType: data.fileType,
        fileSize: data.fileSize,
        filePath: data.filePath,
        fileHash: data.fileHash,
        sourceType: data.sourceType || 'upload',
        sourceUrl: data.sourceUrl,
        classification: data.classification || collection?.defaultClassification || 'INTERNAL',
        uploadedBy: data.uploadedBy,
        status: 'PENDING',
      },
    });

    await publishEvent(KnowledgeEventSubjects.DOCUMENT_UPLOADED, {
      documentId: document.id,
      collectionId: document.collectionId,
      title: document.title,
      uploadedBy: document.uploadedBy,
    });

    logger.info({ documentId: document.id, title: document.title }, 'Document created');
    return document;
  }

  // Update document status after processing
  async updateDocumentStatus(
    id: string,
    status: DocumentStatus,
    chunkCount?: number,
    errorMessage?: string
  ): Promise<Document> {
    const document = await prisma.document.update({
      where: { id },
      data: {
        status,
        chunkCount: chunkCount ?? undefined,
        processedAt: status === 'INDEXED' ? new Date() : undefined,
        errorMessage: errorMessage ?? undefined,
      },
    });

    const eventSubject = status === 'INDEXED' 
      ? KnowledgeEventSubjects.DOCUMENT_INDEXED
      : status === 'FAILED'
        ? KnowledgeEventSubjects.DOCUMENT_FAILED
        : KnowledgeEventSubjects.DOCUMENT_PROCESSED;

    await publishEvent(eventSubject, {
      documentId: id,
      status,
      chunkCount,
    });

    logger.info({ documentId: id, status }, 'Document status updated');
    return document;
  }

  // Update document metadata
  async updateDocument(id: string, data: Partial<{
    title: string;
    description: string;
    classification: Classification;
  }>): Promise<Document> {
    const document = await prisma.document.update({
      where: { id },
      data,
    });
    logger.info({ documentId: id }, 'Document updated');
    return document;
  }

  // Delete document
  async deleteDocument(id: string): Promise<void> {
    // Get document info first
    const document = await prisma.document.findUnique({
      where: { id },
      select: { collectionId: true, filePath: true },
    });

    if (!document) {
      throw new Error('Document not found');
    }

    // Delete document and chunks (cascade)
    await prisma.document.delete({ where: { id } });

    await publishEvent(KnowledgeEventSubjects.DOCUMENT_DELETED, {
      documentId: id,
      collectionId: document.collectionId,
    });

    logger.info({ documentId: id }, 'Document deleted');
    // Note: File cleanup should be handled separately
  }

  // Add chunks to document
  async addChunks(documentId: string, chunks: Array<{
    content: string;
    chunkIndex: number;
    startPage?: number;
    endPage?: number;
    heading?: string;
    tokenCount?: number;
  }>): Promise<number> {
    const result = await prisma.documentChunk.createMany({
      data: chunks.map(chunk => ({
        documentId,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        startPage: chunk.startPage,
        endPage: chunk.endPage,
        heading: chunk.heading,
        tokenCount: chunk.tokenCount || 0,
      })),
    });

    // Update document chunk count
    await prisma.document.update({
      where: { id: documentId },
      data: { chunkCount: result.count },
    });

    logger.info({ documentId, chunkCount: result.count }, 'Chunks added to document');
    return result.count;
  }

  // Get chunks for a document
  async getChunks(documentId: string): Promise<Array<{
    id: string;
    content: string;
    chunkIndex: number;
    heading?: string | null;
  }>> {
    return prisma.documentChunk.findMany({
      where: { documentId },
      select: {
        id: true,
        content: true,
        chunkIndex: true,
        heading: true,
      },
      orderBy: { chunkIndex: 'asc' },
    });
  }

  // Search documents by title/description
  async searchDocuments(query: string, options?: {
    collectionIds?: string[];
    limit?: number;
  }): Promise<Document[]> {
    return prisma.document.findMany({
      where: {
        AND: [
          options?.collectionIds?.length ? { collectionId: { in: options.collectionIds } } : {},
          {
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
            ],
          },
        ],
        status: 'INDEXED',
      },
      take: options?.limit || 20,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Get documents pending processing
  async getPendingDocuments(limit = 10): Promise<Document[]> {
    return prisma.document.findMany({
      where: { status: 'PENDING' },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
  }
}

export const documentService = new DocumentService();
