import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent, KnowledgeEventSubjects } from '../lib/nats.js';

export interface ACLEntry {
  userId?: string;
  groupId?: string;
  departmentId?: string;
  roleId?: string;
  canRead?: boolean;
  canWrite?: boolean;
  canDelete?: boolean;
  canAdmin?: boolean;
  expiresAt?: Date;
}

export class ACLService {
  // ============ COLLECTION ACL ============

  // Grant access to collection
  async grantCollectionAccess(
    collectionId: string,
    entry: ACLEntry,
    grantedBy: string
  ): Promise<void> {
    await prisma.collectionACL.upsert({
      where: {
        collectionId_userId_groupId_departmentId_roleId: {
          collectionId,
          userId: entry.userId ?? null,
          groupId: entry.groupId ?? null,
          departmentId: entry.departmentId ?? null,
          roleId: entry.roleId ?? null,
        },
      },
      update: {
        canRead: entry.canRead ?? true,
        canWrite: entry.canWrite ?? false,
        canDelete: entry.canDelete ?? false,
        canAdmin: entry.canAdmin ?? false,
        expiresAt: entry.expiresAt,
        grantedBy,
        grantedAt: new Date(),
      },
      create: {
        collectionId,
        userId: entry.userId,
        groupId: entry.groupId,
        departmentId: entry.departmentId,
        roleId: entry.roleId,
        canRead: entry.canRead ?? true,
        canWrite: entry.canWrite ?? false,
        canDelete: entry.canDelete ?? false,
        canAdmin: entry.canAdmin ?? false,
        expiresAt: entry.expiresAt,
        grantedBy,
      },
    });

    await publishEvent(KnowledgeEventSubjects.ACL_GRANTED, {
      collectionId,
      entry,
      grantedBy,
    });

    logger.info({ collectionId, entry }, 'Collection access granted');
  }

  // Revoke collection access
  async revokeCollectionAccess(
    collectionId: string,
    entry: { userId?: string; groupId?: string; departmentId?: string; roleId?: string }
  ): Promise<void> {
    await prisma.collectionACL.deleteMany({
      where: {
        collectionId,
        userId: entry.userId ?? undefined,
        groupId: entry.groupId ?? undefined,
        departmentId: entry.departmentId ?? undefined,
        roleId: entry.roleId ?? undefined,
      },
    });

    await publishEvent(KnowledgeEventSubjects.ACL_REVOKED, {
      collectionId,
      entry,
    });

    logger.info({ collectionId, entry }, 'Collection access revoked');
  }

  // Get collection ACL entries
  async getCollectionACL(collectionId: string) {
    return prisma.collectionACL.findMany({
      where: { collectionId },
      orderBy: { grantedAt: 'desc' },
    });
  }

  // Check if user has collection access
  async hasCollectionAccess(
    collectionId: string,
    userId: string,
    departments: string[],
    groups: string[],
    permission: 'read' | 'write' | 'delete' | 'admin' = 'read'
  ): Promise<boolean> {
    const permissionField = {
      read: 'canRead',
      write: 'canWrite',
      delete: 'canDelete',
      admin: 'canAdmin',
    }[permission] as string;

    const acl = await prisma.collectionACL.findFirst({
      where: {
        collectionId,
        [permissionField]: true,
        AND: [
          {
            OR: [
              { userId },
              { departmentId: { in: departments } },
              { groupId: { in: groups } },
            ],
          },
          {
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } },
            ],
          },
        ],
      },
    });

    return !!acl;
  }

  // ============ DOCUMENT ACL ============

  // Grant access to document
  async grantDocumentAccess(
    documentId: string,
    entry: ACLEntry,
    grantedBy: string
  ): Promise<void> {
    await prisma.documentACL.upsert({
      where: {
        documentId_userId_groupId_departmentId: {
          documentId,
          userId: entry.userId ?? null,
          groupId: entry.groupId ?? null,
          departmentId: entry.departmentId ?? null,
        },
      },
      update: {
        canRead: entry.canRead ?? true,
        canWrite: entry.canWrite ?? false,
        expiresAt: entry.expiresAt,
        grantedBy,
        grantedAt: new Date(),
      },
      create: {
        documentId,
        userId: entry.userId,
        groupId: entry.groupId,
        departmentId: entry.departmentId,
        canRead: entry.canRead ?? true,
        canWrite: entry.canWrite ?? false,
        expiresAt: entry.expiresAt,
        grantedBy,
      },
    });

    logger.info({ documentId, entry }, 'Document access granted');
  }

  // Revoke document access
  async revokeDocumentAccess(
    documentId: string,
    entry: { userId?: string; groupId?: string; departmentId?: string }
  ): Promise<void> {
    await prisma.documentACL.deleteMany({
      where: {
        documentId,
        userId: entry.userId ?? undefined,
        groupId: entry.groupId ?? undefined,
        departmentId: entry.departmentId ?? undefined,
      },
    });

    logger.info({ documentId, entry }, 'Document access revoked');
  }

  // Check if user has document access
  async hasDocumentAccess(
    documentId: string,
    userId: string,
    departments: string[],
    groups: string[],
    permission: 'read' | 'write' = 'read'
  ): Promise<boolean> {
    // First check document-level ACL
    const docAcl = await prisma.documentACL.findFirst({
      where: {
        documentId,
        [permission === 'read' ? 'canRead' : 'canWrite']: true,
        AND: [
          {
            OR: [
              { userId },
              { departmentId: { in: departments } },
              { groupId: { in: groups } },
            ],
          },
          {
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } },
            ],
          },
        ],
      },
    });

    if (docAcl) return true;

    // Fall back to collection-level ACL
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { collectionId: true },
    });

    if (!document) return false;

    return this.hasCollectionAccess(
      document.collectionId,
      userId,
      departments,
      groups,
      permission
    );
  }

  // Get all accessible document IDs for a user
  async getAccessibleDocuments(
    userId: string,
    departments: string[],
    groups: string[],
    collectionIds?: string[]
  ): Promise<string[]> {
    // Get accessible collections first
    const collectionAcls = await prisma.collectionACL.findMany({
      where: {
        OR: [
          { userId },
          { departmentId: { in: departments } },
          { groupId: { in: groups } },
        ],
        canRead: true,
        collection: collectionIds?.length ? { id: { in: collectionIds } } : undefined,
      },
      select: { collectionId: true },
    });

    const accessibleCollectionIds = collectionAcls.map(a => a.collectionId);

    // Get all documents from accessible collections
    const documents = await prisma.document.findMany({
      where: {
        collectionId: { in: accessibleCollectionIds },
        status: 'INDEXED',
      },
      select: { id: true },
    });

    return documents.map(d => d.id);
  }
}

export const aclService = new ACLService();
