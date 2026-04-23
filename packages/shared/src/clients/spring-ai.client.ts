// packages/shared/src/clients/spring-ai.client.ts
// Shared Spring AI client for all microservices


const SPRING_AI_URL = process.env.SPRING_AI_URL || 'http://localhost:8080';
const TIMEOUT = 60000; // 60s for AI operations

// ================= TYPES =================

export interface UserPermissionContext {
  userId: string;
  roles: string[];
  roleLevel: number;
  departments: string[];
  groups: string[];
  accessibleCollections?: string[];
  accessibleDocuments?: string[];
}

export interface RAGQueryRequest {
  query: string;
  userContext: UserPermissionContext;
  options?: {
    maxResults?: number;
    minScore?: number;
    collections?: string[];
    includeMetadata?: boolean;
    streamResponse?: boolean;
  };
}

export interface RAGSource {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  content: string;
  score: number;
  metadata?: {
    collectionId?: string;
    classification?: string;
    chunkIndex?: number;
    heading?: string;
  };
}

export interface RAGResponse {
  answer: string;
  sources: RAGSource[];
  metadata?: {
    tokensUsed?: number;
    processingTime?: number;
    model?: string;
  };
}

export interface DocumentIndexRequest {
  documentId: string;
  title: string;
  content: string;
  chunks: Array<{
    chunkId: string;
    content: string;
    metadata: Record<string, unknown>;
  }>;
  acl: {
    collectionId: string;
    classification: string;
    accessList: Array<{
      type: 'user' | 'group' | 'department' | 'role';
      id: string;
    }>;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  userContext: UserPermissionContext;
  enableRAG?: boolean;
  ragOptions?: {
    maxSources?: number;
    collections?: string[];
  };
}

export interface ChatResponse {
  message: ChatMessage;
  sources?: RAGSource[];
  metadata?: Record<string, unknown>;
}

// ================= CLIENT =================

class SpringAIClient {
  private baseUrl: string;

  constructor(baseUrl: string = SPRING_AI_URL) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeout: number = TIMEOUT
  ): Promise<T | null> {
    const startTime = Date.now();
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.warn(`[SpringAI] ${method} ${path} failed: ${response.status} (${elapsed}ms)`);
        console.warn(`[SpringAI] Error: ${errorText}`);
        return null;
      }

      const result = await response.json();
      console.debug(`[SpringAI] ${method} ${path} success (${elapsed}ms)`);
      return result as T;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      if ((error as Error).name === 'AbortError') {
        console.error(`[SpringAI] ${method} ${path} timeout after ${elapsed}ms`);
      } else {
        console.error(`[SpringAI] ${method} ${path} error: ${(error as Error).message}`);
      }
      return null;
    }
  }

  // ================= RAG ENDPOINTS =================

  /**
   * Execute a RAG query with permission-aware filtering
   */
  async ragQuery(request: RAGQueryRequest): Promise<RAGResponse | null> {
    return this.request<RAGResponse>('POST', '/api/rag/query', request);
  }

  /**
   * Get similar documents for a query (without generating answer)
   */
  async findSimilar(
    query: string,
    userContext: UserPermissionContext,
    limit = 5
  ): Promise<RAGSource[] | null> {
    const result = await this.request<{ sources: RAGSource[] }>(
      'POST',
      '/api/rag/similar',
      { query, userContext, limit }
    );
    return result?.sources ?? null;
  }

  // ================= DOCUMENT INDEXING =================

  /**
   * Index a document for RAG
   */
  async indexDocument(request: DocumentIndexRequest): Promise<boolean> {
    const result = await this.request<{ success: boolean }>(
      'POST',
      '/api/documents/index',
      request
    );
    return result?.success ?? false;
  }

  /**
   * Delete a document from the index
   */
  async deleteDocument(documentId: string): Promise<boolean> {
    const result = await this.request<{ success: boolean }>(
      'DELETE',
      `/api/documents/${documentId}`
    );
    return result?.success ?? false;
  }

  /**
   * Update document ACL in the index
   */
  async updateDocumentACL(
    documentId: string,
    acl: DocumentIndexRequest['acl']
  ): Promise<boolean> {
    const result = await this.request<{ success: boolean }>(
      'PATCH',
      `/api/documents/${documentId}/acl`,
      { acl }
    );
    return result?.success ?? false;
  }

  // ================= CHAT ENDPOINTS =================

  /**
   * Chat with AI (with optional RAG augmentation)
   */
  async chat(request: ChatRequest): Promise<ChatResponse | null> {
    return this.request<ChatResponse>('POST', '/api/chat', request, 120000); // 2min timeout for chat
  }

  /**
   * Chat with streaming response
   */
  async* chatStream(request: ChatRequest): AsyncGenerator<string, void, unknown> {
    try {
      const response = await fetch(`${this.baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (!response.ok || !response.body) {
        console.error('[SpringAI] Stream request failed');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        yield chunk;
      }
    } catch (error) {
      console.error('[SpringAI] Stream error:', (error as Error).message);
    }
  }

  // ================= HEALTH & ADMIN =================

  /**
   * Health check
   */
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

  /**
   * Get index stats
   */
  async getStats(): Promise<{
    documentCount: number;
    chunkCount: number;
    lastUpdated: string;
  } | null> {
    return this.request('GET', '/api/admin/stats');
  }

  /**
   * Trigger reindex for a collection
   */
  async reindexCollection(collectionId: string): Promise<boolean> {
    const result = await this.request<{ started: boolean }>(
      'POST',
      `/api/admin/reindex/${collectionId}`
    );
    return result?.started ?? false;
  }
}

// Export singleton instance
export const springAIClient = new SpringAIClient();

// Export class for custom instances
export { SpringAIClient };
