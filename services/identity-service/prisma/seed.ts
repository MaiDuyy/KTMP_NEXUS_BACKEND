// seed.ts
// Seed default roles and permissions for enterprise RBAC

import { PrismaClient as AuthClient } from '../node_modules/.prisma/client-auth/index.js';
import { PrismaClient as UserOrgClient } from '../node_modules/.prisma/client-userorg/index.js';
import { PrismaClient as RbacClient } from '../node_modules/.prisma/client-rbac/index.js';
import bcrypt from 'bcryptjs';

const prismaAuth = new AuthClient();
const prismaUserOrg = new UserOrgClient();
const prismaRbac = new RbacClient();

// Default system roles with hierarchy levels
const SYSTEM_ROLES = [
  { name: 'SUPER_ADMIN', displayName: 'Super Admin', description: 'Toàn quyền hệ thống', level: 0 },
  { name: 'ADMIN', displayName: 'Admin', description: 'Quản trị hệ thống', level: 1 },
  { name: 'WORKSPACE_MANAGER', displayName: 'Workspace Manager', description: 'Quản lý không gian làm việc', level: 2 },
  { name: 'EMPLOYEE', displayName: 'Employee', description: 'Nhân viên chính thức', level: 3 },
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
  ADMIN: [
    'user:read:org', 'user:write:org', 'user:delete:org', 'user:admin:org',
    'chat.channel:read:org', 'chat.channel:admin:org',
    'chat.dm:read:org',
    'knowledge:read:system',
    'ai:execute:own',
    'audit:read:org',
    'role:read:system', 'role:assign:org',
  ],
  WORKSPACE_MANAGER: [
    'user:read:org', 'user:write:org',
    'chat.channel:read:org', 'chat.channel:admin:org',
    'knowledge:read:system',
    'ai:execute:own',
    'role:read:system', 'role:assign:org',
  ],
  EMPLOYEE: [
    'user:read:own', 'user:read:org', 'user:write:own',
    'chat.channel:read:member', 'chat.channel:write:member',
    'chat.dm:read:own', 'chat.dm:write:own',
    'knowledge:read:acl',
    'ai:execute:own',
    'audit:read:own',
  ],
};

async function main() {
  console.log('🌱 Skipping clearing database for safe/idempotent seed...');
  /*
  console.log('🧹 Clearing existing data from databases...');
  
  // Clear RBAC Database
  await prismaRbac.userRole.deleteMany({}).catch(() => {});
  await prismaRbac.rolePermission.deleteMany({}).catch(() => {});
  await prismaRbac.departmentMember.deleteMany({}).catch(() => {});
  await prismaRbac.departmentInvitation.deleteMany({}).catch(() => {});
  await prismaRbac.department.deleteMany({}).catch(() => {});
  await prismaRbac.groupMember.deleteMany({}).catch(() => {});
  await prismaRbac.group.deleteMany({}).catch(() => {});
  await prismaRbac.role.deleteMany({}).catch(() => {});
  await prismaRbac.permission.deleteMany({}).catch(() => {});

  // Clear UserOrg Database
  await prismaUserOrg.invitation.deleteMany({}).catch(() => {});
  await prismaUserOrg.account.deleteMany({}).catch(() => {});
  await prismaUserOrg.organization.deleteMany({}).catch(() => {});

  // Clear Auth Database
  await prismaAuth.account.deleteMany({}).catch(() => {});
  */

  console.log('🌱 Seeding RBAC database...');

  // Create permissions
  console.log('Creating permissions...');
  for (const perm of PERMISSIONS) {
    await prismaRbac.permission.upsert({
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
    await prismaRbac.role.upsert({
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
    const role = await prismaRbac.role.findUnique({ where: { name: roleName } });
    if (!role) continue;

    for (const permKey of permKeys) {
      const [resource, action, scope] = permKey.split(':');
      const permission = await prismaRbac.permission.findUnique({
        where: {
          resource_action_scope: { resource, action, scope },
        },
      });

      if (permission) {
        await prismaRbac.rolePermission.upsert({
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

  // ================= SEEDING ACCOUNTS =================
  console.log('\n🌱 Seeding accounts...');
  
  const DEFAULT_PASSWORD = await bcrypt.hash('123123', 10);
  const WORKSPACE_ID = 'ws-example-01';
  const ORG_ID = 'main-org';

  // Seed default Organization first to satisfy DB relation
  console.log('Creating default organization...');
  await prismaUserOrg.organization.upsert({
    where: { id: ORG_ID },
    update: {
      name: 'Tổ chức Chính thức',
      slug: 'chinh-thuc',
      domain: 'gmail.com',
      superAdminId: 'admin-0000-0000-0000-000000000000',
    },
    create: {
      id: ORG_ID,
      name: 'Tổ chức Chính thức',
      slug: 'chinh-thuc',
      domain: 'gmail.com',
      superAdminId: 'admin-0000-0000-0000-000000000000',
    }
  });

  const accountsToSeed = [
    {
      id: 'admin-0000-0000-0000-000000000000',
      name: 'Phạm Mai Duy',
      email: 'phammaiduy1207@gmail.com',
      number: '0900000001',
      role: 'SUPER_ADMIN',
      authRole: 'SUPER_ADMIN',
      orgRole: 'SUPER_ADMIN',
      deptRole: 'HEAD',
    },
    {
      id: 'mgr-0000-0000-0000-000000000000',
      name: 'Phạm Mai Nhật',
      email: 'phammainhat123@gmail.com',
      number: '0900000002',
      role: 'WORKSPACE_MANAGER',
      authRole: 'WORKSPACE_MANAGER',
      orgRole: 'WORKSPACE_MANAGER',
      workspaceId: WORKSPACE_ID,
      deptRole: 'MANAGER',
    },
    {
      id: 'emp1-0000-0000-0000-000000000000',
      name: 'Tiz Gaming',
      email: 'tizgaming1207@gmail.com',
      number: '0900000003',
      role: 'EMPLOYEE',
      authRole: 'EMPLOYEE',
      orgRole: 'EMPLOYEE',
      workspaceId: WORKSPACE_ID,
      deptRole: 'MEMBER',
    },
    {
      id: 'emp2-0000-0000-0000-000000000000',
      name: 'Duy Mai',
      email: 'duyyymai@gmail.com',
      number: '0900000004',
      role: 'EMPLOYEE',
      authRole: 'EMPLOYEE',
      orgRole: 'EMPLOYEE',
      workspaceId: WORKSPACE_ID,
      deptRole: 'MEMBER',
    }
  ];

  for (const acc of accountsToSeed) {
    console.log(`Creating account: ${acc.email}...`);
    // 1. Seed Auth Database
    await prismaAuth.account.upsert({
      where: { email: acc.email },
      update: {},
      create: {
        id: acc.id,
        name: acc.name,
        email: acc.email,
        number: acc.number,
        password: DEFAULT_PASSWORD,
        gender: 'MALE',
        role: acc.authRole as any,
        isVerified: true
      }
    });

    // 2. Seed UserOrg Database
    await prismaUserOrg.account.upsert({
      where: { email: acc.email },
      update: {},
      create: {
        id: acc.id,
        name: acc.name,
        email: acc.email,
        number: acc.number,
        password: DEFAULT_PASSWORD,
        gender: 'MALE',
        role: acc.orgRole as any,
        orgId: ORG_ID,
        isVerified: true
      }
    });

    // 3. Seed RBAC Database (UserRole)
    const roleRecord = await prismaRbac.role.findUnique({ where: { name: acc.role } });
    if (roleRecord) {
      await prismaRbac.userRole.upsert({
        where: {
          userId_roleId_orgId_workspaceId: {
            userId: acc.id,
            roleId: roleRecord.id,
            orgId: ORG_ID,
            workspaceId: acc.workspaceId || 'personal',
          }
        },
        update: {},
        create: {
          userId: acc.id,
          roleId: roleRecord.id,
          orgId: ORG_ID,
          workspaceId: acc.workspaceId || 'personal',
          grantedBy: 'system'
        }
      });
    }
  }

  console.log(`✅ Seeded ${accountsToSeed.length} accounts across all databases`);

  // ================= SEEDING DEPARTMENTS =================
  console.log('\n🌱 Seeding department and memberships...');
  const DEPT_ID = 'tech-dept-0000-0000-0000-000000000000';
  await prismaRbac.department.upsert({
    where: { id: DEPT_ID },
    update: {
      name: 'IT',
      description: 'Nghiên cứu và phát triển phần mềm',
      managerId: 'admin-0000-0000-0000-000000000000'
    },
    create: {
      id: DEPT_ID,
      name: 'IT',
      description: 'Nghiên cứu và phát triển phần mềm',
      managerId: 'admin-0000-0000-0000-000000000000'
    }
  });

  for (const acc of accountsToSeed) {
    if (acc.deptRole) {
      await prismaRbac.departmentMember.upsert({
        where: {
          userId_departmentId: {
            userId: acc.id,
            departmentId: DEPT_ID
          }
        },
        update: {
          role: acc.deptRole,
          isPrimary: true
        },
        create: {
          userId: acc.id,
          departmentId: DEPT_ID,
          role: acc.deptRole,
          isPrimary: true
        }
      });
    }
  }
  console.log('✅ Department and memberships seeded successfully');

  console.log('\n🎉 Identity seeding complete!');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prismaAuth.$disconnect();
    await prismaUserOrg.$disconnect();
    await prismaRbac.$disconnect();
  });
