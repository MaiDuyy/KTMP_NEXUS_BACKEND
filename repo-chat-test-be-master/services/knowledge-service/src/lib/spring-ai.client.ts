// services/knowledge-service/src/lib/spring-ai.client.ts
// HTTP client to communicate with Spring AI backend for RAG

import { logger } from './logger.js';

const SPRING_AI_URL = process.env.SPRING_AI_URL || 'http://localhost:8080';
const TIMEOUT = 30000; // 30s for AI operations

// ============= Exported Types =============

export interface DocumentSyncPayload {
  documentId: string;
  title: string;
  content: string;
  chunks: Array<{
    chunkId: string;
    content: string;
    metadata: {
      chunkIndex: number;
      startPage?: number;
      endPage?: number;
      heading?: string;
    };
  }>;
  metadata: {
    collectionId: string;
    classification: string;
    uploadedBy: string;
    departments?: string[];
    groups?: string[];
    acl?: Array<{
      type: 'user' | 'group' | 'department' | 'role';
      id: string;
    }>;
  };
}

export interface UserPermissionContext {
  userId: string;
  roles: string[];
  roleLevel: number;
  departments: string[];
  groups: string[];
  accessibleCollections?: string[];
}

export interface RAGQueryRequest {
  query: string;
  userContext: UserPermissionContext;
  options?: {
    maxResults?: number;
    minScore?: number;
    collections?: string[];
  };
}

export interface RAGResponse {
  answer: string;
  sources: Array<{
    documentId: string;
    documentTitle: string;
    chunkId: string;
    content: string;
    score: number;
  }>;
  metadata?: Record<string, unknown>;
}

export interface ChatRequest {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  userContext: UserPermissionContext;
  enableRAG?: boolean;
  ragOptions?: {
    maxSources?: number;
    collections?: string[];
  };
}

export interface ChatResponse {
  response: string;
  sources?: RAGResponse['sources'];
  conversationId?: string;
}

// ============= Internal Types =============

interface SpringAIResponse<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

// ============= Client =============

class SpringAIClient {
  private baseUrl: string;

  constructor(baseUrl: string = SPRING_AI_URL) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn({ status: response.status, path }, 'Spring AI request failed');
        return null;
      }

      const result: SpringAIResponse<T> = await response.json();
      return result.data ?? (result as T);
    } catch (error) {
      logger.warn({ error, path }, 'Spring AI service unavailable');
      return null;
    }
  }

  // Index a document for RAG
  async indexDocument(payload: DocumentSyncPayload): Promise<boolean> {
    const result = await this.request<{ indexed: boolean }>(
      'POST',
      '/api/documents/index',
      payload
    );
    return result?.indexed ?? false;
  }

  // Delete document from index
  async deleteDocument(documentId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      'DELETE',
      `/api/documents/${documentId}`
    );
    return result?.deleted ?? false;
  }

  // Permission-aware RAG query
  async ragQuery(request: RAGQueryRequest): Promise<RAGResponse | null> {
    return this.request<RAGResponse>('POST', '/api/rag/query', {
      query: request.query,
      userId: request.userContext.userId,
      userPermissions: {
        roles: request.userContext.roles,
        roleLevel: request.userContext.roleLevel,
        departments: request.userContext.departments,
        groups: request.userContext.groups,
        accessibleCollections: request.userContext.accessibleCollections,
      },
      options: request.options,
    });
  }

  // Find similar documents (uses RAG query with no answer generation)
  async findSimilar(
    query: string,
    userContext: UserPermissionContext,
    limit = 5
  ): Promise<RAGResponse['sources'] | null> {
    const result = await this.ragQuery({
      query,
      userContext,
      options: { maxResults: limit, minScore: 0.5 },
    });
    return result?.sources ?? null;
  }

  // AI Chat with RAG
  async chat(request: ChatRequest): Promise<ChatResponse | null> {
    return this.request<ChatResponse>('POST', '/api/rag/query', {
      query: request.messages[request.messages.length - 1]?.content ?? '',
      userId: request.userContext.userId,
      userPermissions: {
        roles: request.userContext.roles,
        roleLevel: request.userContext.roleLevel,
        departments: request.userContext.departments,
        groups: request.userContext.groups,
        accessibleCollections: request.userContext.accessibleCollections,
      },
      options: {
        maxResults: request.ragOptions?.maxSources ?? 5,
        collections: request.ragOptions?.collections,
      },
    });
  }

  // Stream chat response (SSE from Spring)
  async *chatStream(request: ChatRequest): AsyncGenerator<string> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const response = await fetch(`${this.baseUrl}/api/rag/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          query: request.messages[request.messages.length - 1]?.content ?? '',
          userId: request.userContext.userId,
          userPermissions: {
            roles: request.userContext.roles,
            roleLevel: request.userContext.roleLevel,
            departments: request.userContext.departments,
            groups: request.userContext.groups,
            accessibleCollections: request.userContext.accessibleCollections,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok || !response.body) {
        logger.warn({ status: response.status }, 'Stream request failed');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            yield data;
          }
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Stream error');
    }
  }

  // Health check
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/actuator/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Re-index a collection
  async reindexCollection(collectionId: string): Promise<boolean> {
    const result = await this.request<{ started: boolean }>(
      'POST',
      `/api/collections/${collectionId}/reindex`
    );
    return result?.started ?? false;
  }
}

export const springAIClient = new SpringAIClient();
