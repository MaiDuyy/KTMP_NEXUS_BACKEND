// services/knowledge-service/src/services/rag.service.ts
// Permission-Aware RAG service - bridges Knowledge and Spring AI

import { prisma } from '../lib/prisma.js';
import { aclService } from './acl.service.js';
import { logger } from '../lib/logger.js';
import {
  springAIClient,
  type RAGQueryRequest,
  type RAGResponse,
  type UserPermissionContext,
} from '../lib/spring-ai.client.js';

const RBAC_SERVICE_URL = process.env.RBAC_SERVICE_URL || 'http://localhost:3015';

// Get user permissions from RBAC service
async function getUserPermissions(userId: string): Promise<{
  roles: string[];
  roleLevel: number;
  departments: string[];
  groups: string[];
} | null> {
  try {
    const response = await fetch(`${RBAC_SERVICE_URL}/users/${userId}/permissions`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const result = await response.json();
    return result.success ? result.data : null;
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to get RBAC permissions');
    return null;
  }
}

export class RAGService {
  /**
   * Build user permission context for RAG queries
   */
  async buildPermissionContext(userId: string): Promise<UserPermissionContext | null> {
    // Get RBAC permissions
    const rbacPerms = await getUserPermissions(userId);
    
    if (!rbacPerms) {
      logger.warn({ userId }, 'No RBAC permissions found for user');
      return null;
    }

    // Get accessible collections
    const accessibleCollections = await aclService.getAccessibleDocuments(
      userId,
      rbacPerms.departments,
      rbacPerms.groups
    ).then(() => {
      // Actually get collection IDs
      return prisma.collectionACL.findMany({
        where: {
          OR: [
            { userId },
            { departmentId: { in: rbacPerms.departments } },
            { groupId: { in: rbacPerms.groups } },
          ],
          canRead: true,
        },
        select: { collectionId: true },
      });
    }).then(acls => [...new Set(acls.map(a => a.collectionId))]);

    return {
      userId,
      roles: rbacPerms.roles,
      roleLevel: rbacPerms.roleLevel,
      departments: rbacPerms.departments,
      groups: rbacPerms.groups,
      accessibleCollections,
    };
  }

  /**
   * Execute a permission-aware RAG query
   */
  async query(
    query: string,
    userId: string,
    options?: {
      maxResults?: number;
      minScore?: number;
      collections?: string[];
    }
  ): Promise<RAGResponse | null> {
    // Build permission context
    const userContext = await this.buildPermissionContext(userId);
    
    if (!userContext) {
      logger.error({ userId }, 'Cannot execute RAG query: no permission context');
      return null;
    }

    // Filter collections if specified
    if (options?.collections) {
      userContext.accessibleCollections = userContext.accessibleCollections?.filter(
        c => options.collections!.includes(c)
      );
    }

    // Execute RAG query via Spring AI
    const request: RAGQueryRequest = {
      query,
      userContext,
      options: {
        maxResults: options?.maxResults || 5,
        minScore: options?.minScore || 0.7,
        collections: userContext.accessibleCollections,
      },
    };

    logger.info({
      userId,
      query: query.slice(0, 50),
      collections: userContext.accessibleCollections?.length || 0,
    }, 'Executing RAG query');

    const response = await springAIClient.ragQuery(request);

    if (response) {
      logger.info({
        userId,
        sourcesCount: response.sources.length,
      }, 'RAG query completed');
    }

    return response;
  }

  /**
   * Find similar documents (no answer generation)
   */
  async findSimilar(
    query: string,
    userId: string,
    limit = 5
  ) {
    const userContext = await this.buildPermissionContext(userId);
    
    if (!userContext) {
      return null;
    }

    return springAIClient.findSimilar(query, userContext, limit);
  }

  /**
   * AI Chat with permission-aware RAG augmentation
   */
  async chat(
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    userId: string,
    options?: {
      enableRAG?: boolean;
      maxSources?: number;
      collections?: string[];
    }
  ) {
    const userContext = await this.buildPermissionContext(userId);
    
    if (!userContext) {
      logger.error({ userId }, 'Cannot execute chat: no permission context');
      return null;
    }

    return springAIClient.chat({
      messages,
      userContext,
      enableRAG: options?.enableRAG ?? true,
      ragOptions: {
        maxSources: options?.maxSources,
        collections: options?.collections,
      },
    });
  }

  /**
   * Stream chat response
   */
  async *chatStream(
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    userId: string,
    options?: {
      enableRAG?: boolean;
      collections?: string[];
    }
  ) {
    const userContext = await this.buildPermissionContext(userId);
    
    if (!userContext) {
      throw new Error('No permission context');
    }

    yield* springAIClient.chatStream({
      messages,
      userContext,
      enableRAG: options?.enableRAG ?? true,
      ragOptions: {
        collections: options?.collections,
      },
    });
  }
}

export const ragService = new RAGService();
