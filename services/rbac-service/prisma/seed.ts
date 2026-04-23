// prisma/seed.ts
// Seed default roles and permissions for enterprise RBAC

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Default system roles with hierarchy levels
const SYSTEM_ROLES = [
  { name: 'SUPER_ADMIN', displayName: 'Super Admin', description: 'Full system access', level: 0 },
  { name: 'ORG_ADMIN', displayName: 'Organization Admin', description: 'Organization management', level: 1 },
  { name: 'SECURITY_OFFICER', displayName: 'Security Officer', description: 'Audit and compliance', level: 2 },
  { name: 'WORKSPACE_MANAGER', displayName: 'Workspace Manager', description: 'Workspace and channel management', level: 3 },
  { name: 'KNOWLEDGE_ADMIN', displayName: 'Knowledge Admin', description: 'Knowledge base management', level: 4 },
  { name: 'AI_ADMIN', displayName: 'AI Admin', description: 'AI configuration', level: 5 },
  { name: 'EMPLOYEE', displayName: 'Employee', description: 'Standard user access', level: 10 },
  { name: 'GUEST', displayName: 'Guest', description: 'Limited external access', level: 20 },
];

// Default permissions matrix
const PERMISSIONS = [
  // User management
  { resource: 'user', action: 'read', scope: 'own', description: 'View own profile' },
  { resource: 'user', action: 'read', scope: 'org', description: 'View users in org' },
  { resource: 'user', action: 'read', scope: 'system', description: 'View all users' },
  { resource: 'user', action: 'write', scope: 'own', description: 'Update own profile' },
  { resource: 'user', action: 'write', scope: 'org', description: 'Update users in org' },
  { resource: 'user', action: 'write', scope: 'system', description: 'Update any user' },
  { resource: 'user', action: 'delete', scope: 'org', description: 'Delete users in org' },
  { resource: 'user', action: 'delete', scope: 'system', description: 'Delete any user' },
  { resource: 'user', action: 'admin', scope: 'org', description: 'Manage org users' },
  { resource: 'user', action: 'admin', scope: 'system', description: 'Manage all users' },

  // Chat
  { resource: 'chat.channel', action: 'read', scope: 'member', description: 'Read channels as member' },
  { resource: 'chat.channel', action: 'read', scope: 'org', description: 'Read all org channels' },
  { resource: 'chat.channel', action: 'write', scope: 'member', description: 'Send messages in channels' },
  { resource: 'chat.channel', action: 'admin', scope: 'workspace', description: 'Manage workspace channels' },
  { resource: 'chat.channel', action: 'admin', scope: 'org', description: 'Manage all org channels' },

  // DM
  { resource: 'chat.dm', action: 'read', scope: 'own', description: 'Read own DMs' },
  { resource: 'chat.dm', action: 'read', scope: 'org', description: 'Read all DMs (admin audit)' },
  { resource: 'chat.dm', action: 'write', scope: 'own', description: 'Send DMs' },

  // Knowledge
  { resource: 'knowledge', action: 'read', scope: 'acl', description: 'Read docs by ACL' },
  { resource: 'knowledge', action: 'read', scope: 'system', description: 'Read all docs' },
  { resource: 'knowledge', action: 'write', scope: 'own', description: 'Upload own docs' },
  { resource: 'knowledge', action: 'write', scope: 'collection', description: 'Manage collection docs' },
  { resource: 'knowledge', action: 'admin', scope: 'system', description: 'Manage all knowledge' },

  // AI
  { resource: 'ai', action: 'execute', scope: 'own', description: 'Use AI assistant' },
  { resource: 'ai', action: 'admin', scope: 'system', description: 'Configure AI settings' },

  // Audit
  { resource: 'audit', action: 'read', scope: 'own', description: 'View own audit logs' },
  { resource: 'audit', action: 'read', scope: 'org', description: 'View org audit logs' },
  { resource: 'audit', action: 'read', scope: 'system', description: 'View all audit logs' },
  { resource: 'audit', action: 'export', scope: 'system', description: 'Export audit logs' },

  // Roles (meta-permission for RBAC)
  { resource: 'role', action: 'read', scope: 'system', description: 'View roles' },
  { resource: 'role', action: 'write', scope: 'system', description: 'Create/update roles' },
  { resource: 'role', action: 'assign', scope: 'org', description: 'Assign roles in org' },
  { resource: 'role', action: 'assign', scope: 'system', description: 'Assign any role' },
];

// Role-permission mapping
const ROLE_PERMISSIONS: Record<string, string[]> = {
  SUPER_ADMIN: [
    // Super admin gets ALL permissions
    ...PERMISSIONS.map(p => `${p.resource}:${p.action}:${p.scope}`),
  ],
  ORG_ADMIN: [
    'user:read:org', 'user:write:org', 'user:delete:org', 'user:admin:org',
    'chat.channel:read:org', 'chat.channel:admin:org',
    'chat.dm:read:org',
    'knowledge:read:system',
    'ai:execute:own',
    'audit:read:org',
    'role:read:system', 'role:assign:org',
  ],
  SECURITY_OFFICER: [
    'user:read:org',
    'chat.dm:read:org',
    'audit:read:system', 'audit:export:system',
    'role:read:system',
  ],
  WORKSPACE_MANAGER: [
    'user:read:org',
    'chat.channel:read:org', 'chat.channel:admin:workspace',
    'chat.dm:read:own', 'chat.dm:write:own',
    'knowledge:read:acl',
    'ai:execute:own',
  ],
  KNOWLEDGE_ADMIN: [
    'user:read:org',
    'knowledge:read:system', 'knowledge:write:collection', 'knowledge:admin:system',
    'ai:execute:own',
  ],
  AI_ADMIN: [
    'user:read:own',
    'knowledge:read:system',
    'ai:execute:own', 'ai:admin:system',
  ],
  EMPLOYEE: [
    'user:read:own', 'user:read:org', 'user:write:own',
    'chat.channel:read:member', 'chat.channel:write:member',
    'chat.dm:read:own', 'chat.dm:write:own',
    'knowledge:read:acl',
    'ai:execute:own',
    'audit:read:own',
  ],
  GUEST: [
    'user:read:own',
    'chat.channel:read:member',
  ],
};

async function main() {
  console.log('🌱 Seeding RBAC database...');

  // Create permissions
  console.log('Creating permissions...');
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: {
        resource_action_scope: {
          resource: perm.resource,
          action: perm.action,
          scope: perm.scope,
        },
      },
      update: { description: perm.description },
      create: perm,
    });
  }
  console.log(`✅ Created ${PERMISSIONS.length} permissions`);

  // Create roles
  console.log('Creating roles...');
  for (const role of SYSTEM_ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {
        displayName: role.displayName,
        description: role.description,
        level: role.level,
      },
      create: {
        ...role,
        isSystem: true,
      },
    });
  }
  console.log(`✅ Created ${SYSTEM_ROLES.length} system roles`);

  // Assign permissions to roles
  console.log('Assigning permissions to roles...');
  for (const [roleName, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;

    for (const permKey of permKeys) {
      const [resource, action, scope] = permKey.split(':');
      const permission = await prisma.permission.findUnique({
        where: {
          resource_action_scope: { resource, action, scope },
        },
      });

      if (permission) {
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: {
            roleId: role.id,
            permissionId: permission.id,
          },
        });
      }
    }
  }
  console.log('✅ Permissions assigned to roles');

  console.log('\n🎉 RBAC seeding complete!');
  console.log('\nRoles created:');
  const roles = await prisma.role.findMany({ orderBy: { level: 'asc' } });
  for (const r of roles) {
    console.log(`  • ${r.name} (Level ${r.level}) - ${r.displayName}`);
  }
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
