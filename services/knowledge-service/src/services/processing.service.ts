// services/knowledge-service/src/services/processing.service.ts
// Document processing pipeline - parsing, chunking, indexing

import { documentService } from './document.service.js';
import { springAIClient } from '../lib/spring-ai.client.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { Document } from '@prisma/client';
import { readFile } from 'fs/promises';
import path from 'path';

// Simple text extraction (production would use dedicated parsers)
async function extractText(filePath: string, fileType: string): Promise<string> {
  const buffer = await readFile(filePath);
  
  // For text files
  if (fileType.includes('text/') || fileType.includes('application/json')) {
    return buffer.toString('utf-8');
  }
  
  // For PDF - in production use pdf-parse or similar
  if (fileType === 'application/pdf') {
    // Placeholder: In production, use pdf-parse
    // const pdfParse = await import('pdf-parse');
    // const data = await pdfParse.default(buffer);
    // return data.text;
    return `[PDF Content - ${buffer.length} bytes]`;
  }
  
  // For other types, return placeholder
  return `[Binary content - ${buffer.length} bytes]`;
}

// Chunk text into smaller pieces for RAG
function chunkText(
  text: string,
  options: { chunkSize?: number; overlap?: number } = {}
): Array<{ content: string; chunkIndex: number }> {
  const chunkSize = options.chunkSize || 1000;
  const overlap = options.overlap || 200;
  const chunks: Array<{ content: string; chunkIndex: number }> = [];
  
  // Split by paragraphs first
  const paragraphs = text.split(/\n\s*\n/);
  let currentChunk = '';
  let chunkIndex = 0;
  
  for (const para of paragraphs) {
    if (currentChunk.length + para.length > chunkSize && currentChunk.length > 0) {
      chunks.push({ content: currentChunk.trim(), chunkIndex });
      chunkIndex++;
      // Keep overlap from previous chunk
      currentChunk = currentChunk.slice(-overlap) + '\n\n' + para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }
  
  // Add final chunk
  if (currentChunk.trim()) {
    chunks.push({ content: currentChunk.trim(), chunkIndex });
  }
  
  return chunks;
}

// Count tokens (simple approximation: 1 token ≈ 4 chars)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ProcessingService {
  // Process a single document
  async processDocument(documentId: string): Promise<boolean> {
    try {
      // Get document
      const document = await prisma.document.findUnique({
        where: { id: documentId },
        include: { collection: true },
      });

      if (!document) {
        logger.error({ documentId }, 'Document not found');
        return false;
      }

      logger.info({ documentId, title: document.title }, 'Processing document');

      // Update status to PROCESSING
      await documentService.updateDocumentStatus(documentId, 'PROCESSING');

      // Extract text
      const text = await extractText(document.filePath, document.fileType);
      
      if (!text || text.length < 10) {
        await documentService.updateDocumentStatus(documentId, 'FAILED', 0, 'No text extracted');
        return false;
      }

      // Chunk text
      const textChunks = chunkText(text);
      
      // Save chunks to database
      const chunks = textChunks.map(chunk => ({
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        tokenCount: estimateTokens(chunk.content),
      }));

      await documentService.addChunks(documentId, chunks);

      // Get ACL info for Spring AI
      const acl = await prisma.collectionACL.findMany({
        where: { collectionId: document.collectionId },
        select: {
          userId: true,
          groupId: true,
          departmentId: true,
          roleId: true,
        },
      });

      // Index in Spring AI
      const indexSuccess = await springAIClient.indexDocument({
        documentId: document.id,
        title: document.title,
        content: text,
        chunks: textChunks.map((chunk, i) => ({
          chunkId: `${documentId}_chunk_${i}`,
          content: chunk.content,
          metadata: { chunkIndex: chunk.chunkIndex },
        })),
        metadata: {
          collectionId: document.collectionId,
          classification: document.classification,
          uploadedBy: document.uploadedBy,
          acl: acl.map(a => {
            if (a.userId) return { type: 'user' as const, id: a.userId };
            if (a.groupId) return { type: 'group' as const, id: a.groupId };
            if (a.departmentId) return { type: 'department' as const, id: a.departmentId };
            if (a.roleId) return { type: 'role' as const, id: a.roleId };
            return { type: 'user' as const, id: '' };
          }).filter(a => a.id),
        },
      });

      if (!indexSuccess) {
        logger.warn({ documentId }, 'Spring AI indexing failed, document saved locally');
      }

      // Update status to INDEXED
      await documentService.updateDocumentStatus(documentId, 'INDEXED', chunks.length);
      
      logger.info({ documentId, chunkCount: chunks.length }, 'Document processed successfully');
      return true;
    } catch (error) {
      logger.error({ error, documentId }, 'Document processing failed');
      await documentService.updateDocumentStatus(
        documentId, 
        'FAILED', 
        0, 
        error instanceof Error ? error.message : 'Unknown error'
      );
      return false;
    }
  }

  // Process all pending documents
  async processPendingDocuments(): Promise<number> {
    const pending = await documentService.getPendingDocuments(10);
    let processed = 0;

    for (const doc of pending) {
      const success = await this.processDocument(doc.id);
      if (success) processed++;
    }

    if (processed > 0) {
      logger.info({ processed, total: pending.length }, 'Batch processing complete');
    }

    return processed;
  }

  // Reindex a document (for updates)
  async reindexDocument(documentId: string): Promise<boolean> {
    // Delete existing chunks
    await prisma.documentChunk.deleteMany({
      where: { documentId },
    });

    // Reset status
    await documentService.updateDocumentStatus(documentId, 'PENDING');

    // Reprocess
    return this.processDocument(documentId);
  }
}

export const processingService = new ProcessingService();
