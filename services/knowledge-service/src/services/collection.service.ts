import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent, KnowledgeEventSubjects } from '../lib/nats.js';
import type { Collection, Classification } from '@prisma/client';

export class CollectionService {
  // Get all collections (with access filtering)
  async getCollections(options?: {
    userId?: string;
    includeDocumentCount?: boolean;
  }): Promise<Collection[]> {
    return prisma.collection.findMany({
      where: { isActive: true },
      include: options?.includeDocumentCount ? {
        _count: { select: { documents: true } }
      } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  // Get collection by ID
  async getCollectionById(id: string): Promise<Collection | null> {
    return prisma.collection.findUnique({
      where: { id },
      include: {
        acl: true,
        _count: { select: { documents: true } },
      },
    });
  }

  // Create a collection
  async createCollection(data: {
    name: string;
    description?: string;
    ownerId: string;
    defaultClassification?: Classification;
    isAIEnabled?: boolean;
    ragPriority?: number;
  }): Promise<Collection> {
    const collection = await prisma.collection.create({
      data: {
        name: data.name,
        description: data.description,
        ownerId: data.ownerId,
        defaultClassification: data.defaultClassification || 'INTERNAL',
        isAIEnabled: data.isAIEnabled ?? true,
        ragPriority: data.ragPriority ?? 5,
      },
    });

    // Create owner ACL automatically
    await prisma.collectionACL.create({
      data: {
        collectionId: collection.id,
        userId: data.ownerId,
        canRead: true,
        canWrite: true,
        canDelete: true,
        canAdmin: true,
        grantedBy: data.ownerId,
      },
    });

    await publishEvent(KnowledgeEventSubjects.COLLECTION_CREATED, {
      collectionId: collection.id,
      name: collection.name,
      ownerId: collection.ownerId,
    });

    logger.info({ collectionId: collection.id, name: collection.name }, 'Collection created');
    return collection;
  }

  // Update collection
  async updateCollection(id: string, data: Partial<{
    name: string;
    description: string;
    defaultClassification: Classification;
    isAIEnabled: boolean;
    ragPriority: number;
  }>): Promise<Collection> {
    const collection = await prisma.collection.update({
      where: { id },
      data,
    });

    await publishEvent(KnowledgeEventSubjects.COLLECTION_UPDATED, {
      collectionId: id,
      changes: Object.keys(data),
    });

    logger.info({ collectionId: id }, 'Collection updated');
    return collection;
  }

  // Delete (soft delete) collection
  async deleteCollection(id: string): Promise<void> {
    await prisma.collection.update({
      where: { id },
      data: { isActive: false },
    });

    await publishEvent(KnowledgeEventSubjects.COLLECTION_DELETED, { collectionId: id });
    logger.info({ collectionId: id }, 'Collection deleted');
  }

  // Get collections accessible by user
  async getAccessibleCollections(userId: string, departments: string[], groups: string[]): Promise<string[]> {
    const acls = await prisma.collectionACL.findMany({
      where: {
        OR: [
          { userId },
          { departmentId: { in: departments } },
          { groupId: { in: groups } },
        ],
        canRead: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      select: { collectionId: true },
    });

    return [...new Set(acls.map(a => a.collectionId))];
  }
}

export const collectionService = new CollectionService();
