// packages/shared/src/constants/permissions.ts
// Permission constants for enterprise RBAC

// Resource types
export const RESOURCES = {
  USER: 'user',
  CHAT_CHANNEL: 'chat.channel',
  CHAT_DM: 'chat.dm',
  KNOWLEDGE: 'knowledge',
  AI: 'ai',
  AUDIT: 'audit',
  ROLE: 'role',
} as const;

// Action types
export const ACTIONS = {
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  ADMIN: 'admin',
  EXECUTE: 'execute',
  ASSIGN: 'assign',
  EXPORT: 'export',
} as const;

// Scope types
export const SCOPES = {
  OWN: 'own',
  TEAM: 'team',
  DEPARTMENT: 'department',
  ORG: 'org',
  SYSTEM: 'system',
  MEMBER: 'member',
  ACL: 'acl',
  WORKSPACE: 'workspace',
  COLLECTION: 'collection',
} as const;

export type Resource = (typeof RESOURCES)[keyof typeof RESOURCES];
export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

// Permission string format: resource:action:scope
export type PermissionString = `${Resource}:${Action}:${Scope}`;

// Helper to create permission string
export function createPermission(resource: Resource, action: Action, scope: Scope): PermissionString {
  return `${resource}:${action}:${scope}`;
}

// Check if permission string matches
export function matchesPermission(
  userPerm: { resource: string; action: string; scope: string },
  required: PermissionString
): boolean {
  const [reqResource, reqAction, reqScope] = required.split(':');
  
  // Exact match or system scope (system scope implies access to all)
  if (userPerm.scope === 'system') {
    return userPerm.resource === reqResource && userPerm.action === reqAction;
  }
  
  return (
    userPerm.resource === reqResource &&
    userPerm.action === reqAction &&
    userPerm.scope === reqScope
  );
}
