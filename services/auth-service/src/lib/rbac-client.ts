// services/auth-service/src/lib/rbac-client.ts
// HTTP client to communicate with RBAC service

import { logger } from './logger.js';

const RBAC_SERVICE_URL = process.env.RBAC_SERVICE_URL || 'http://localhost:3016';
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

      const result: RBACResponse<T> = await response.json();
      return result.success ? result.data ?? null : null;
    } catch (error) {
      logger.warn({ error, path }, 'RBAC service unavailable');
      return null;
    }
  }

  // Get user permissions from RBAC service
  async getUserPermissions(userId: string): Promise<UserPermissions | null> {
    return this.request<UserPermissions>('GET', `/users/${userId}/permissions`);
  }

  // Assign role to user
  async assignRole(
    userId: string,
    roleName: string,
    grantedBy: string
  ): Promise<boolean> {
    // First get role ID by name
    const roles = await this.request<Array<{ id: string; name: string }>>(
      'GET',
      '/roles'
    );
    
    if (!roles) return false;

    const role = roles.find(r => r.name === roleName);
    if (!role) {
      logger.warn({ roleName }, 'Role not found in RBAC service');
      return false;
    }

    const result = await this.request<{ id: string }>(
      'POST',
      `/users/${userId}/roles`,
      { roleId: role.id, grantedBy }
    );

    return result !== null;
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
