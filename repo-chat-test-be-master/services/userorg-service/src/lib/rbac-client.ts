// services/userorg-service/src/lib/rbac-client.ts
// HTTP client to communicate with RBAC service

import { logger } from './logger.js';

const RBAC_SERVICE_URL = process.env.RBAC_SERVICE_URL || 'http://localhost:3015';
const TIMEOUT = 5000;

export interface UserPermissions {
  userId: string;
  roles: string[];
  roleLevel: number;
  departments: string[];
  groups: string[];
  permissions: Array<{
    resource: string;
    action: string;
    scope: string;
  }>;
}

interface RBACResponse<T> {
  success: boolean;
  data?: T;
  error?: { message: string; code: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRBACResponseShape(value: unknown): value is { success: boolean } {
  return isObject(value) && typeof value.success === 'boolean';
}

class RBACClient {
  private baseUrl: string;

  constructor(baseUrl: string = RBAC_SERVICE_URL) {
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
        logger.warn({ status: response.status, path }, 'RBAC request failed');
        return null;
      }

      // response.json() is unknown -> parse then validate minimal shape
      const json: unknown = await response.json().catch(() => null);

      if (!isRBACResponseShape(json)) {
        logger.warn({ path, json }, 'RBAC response has invalid shape');
        return null;
      }

      const result = json as RBACResponse<T>;
      return result.success ? (result.data ?? null) : null;
    } catch (error) {
      logger.warn({ error, path }, 'RBAC service unavailable');
      return null;
    }
  }

  // Get user permissions from RBAC service
  async getUserPermissions(userId: string): Promise<UserPermissions | null> {
    return this.request<UserPermissions>('GET', `/users/${userId}/permissions`);
  }

  // Check if user has permission
  async checkPermission(
    userId: string,
    resource: string,
    action: string,
    scope?: string
  ): Promise<boolean> {
    const result = await this.request<{ allowed: boolean }>(
      'POST',
      '/check',
      { userId, resource, action, scope }
    );

    return result?.allowed ?? false;
  }

  // Check if user has specific role(s)
  async hasRole(userId: string, roleNames: string[]): Promise<boolean> {
    const result = await this.request<{ hasRole: boolean }>(
      'POST',
      '/check-role',
      { userId, roles: roleNames }
    );

    return result?.hasRole ?? false;
  }

  // Health check
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const rbacClient = new RBACClient();
