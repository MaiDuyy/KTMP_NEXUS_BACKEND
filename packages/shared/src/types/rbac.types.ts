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
  ORG_ADMIN = 'ORG_ADMIN',
  SECURITY_OFFICER = 'SECURITY_OFFICER',
  WORKSPACE_MANAGER = 'WORKSPACE_MANAGER',
  KNOWLEDGE_ADMIN = 'KNOWLEDGE_ADMIN',
  AI_ADMIN = 'AI_ADMIN',
  EMPLOYEE = 'EMPLOYEE',
  GUEST = 'GUEST',
}

// Role levels for hierarchy comparison
export const ROLE_LEVELS: Record<SystemRole, number> = {
  [SystemRole.SUPER_ADMIN]: 0,
  [SystemRole.ORG_ADMIN]: 1,
  [SystemRole.SECURITY_OFFICER]: 2,
  [SystemRole.WORKSPACE_MANAGER]: 3,
  [SystemRole.KNOWLEDGE_ADMIN]: 4,
  [SystemRole.AI_ADMIN]: 5,
  [SystemRole.EMPLOYEE]: 10,
  [SystemRole.GUEST]: 20,
};
