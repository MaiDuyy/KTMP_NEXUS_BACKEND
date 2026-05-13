// packages/shared/src/types/rbac.types.ts
// Shared RBAC types across all microservices

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

export interface TokenPayload {
  id: string; // Resolved from JWT 'sub' claim by gateway middleware
  role: string;
  roles?: string[]; // RBAC roles
  roleLevel?: number;
  iat?: number;
  exp?: number;
}

// System roles enum for type safety
export enum SystemRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  WORKSPACE_MANAGER = 'WORKSPACE_MANAGER',
  EMPLOYEE = 'EMPLOYEE',
}

// Role levels for hierarchy comparison
export const ROLE_LEVELS: Record<SystemRole, number> = {
  [SystemRole.SUPER_ADMIN]: 0,
  [SystemRole.ADMIN]: 1,
  [SystemRole.WORKSPACE_MANAGER]: 2,
  [SystemRole.EMPLOYEE]: 3,
};
