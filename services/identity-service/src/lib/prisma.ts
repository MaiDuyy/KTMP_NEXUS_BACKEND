// services/identity-service/src/lib/prisma.ts
// Multi-schema Prisma clients for identity-service
// Each client connects to a different PostgreSQL schema

import { PrismaClient as AuthPrismaClient } from '../../node_modules/.prisma/client-auth/index.js';
import { PrismaClient as UserOrgPrismaClient } from '../../node_modules/.prisma/client-userorg/index.js';
import { PrismaClient as RBACPrismaClient } from '../../node_modules/.prisma/client-rbac/index.js';

const logConfig = process.env.NODE_ENV === 'development' ? ['error', 'warn'] as const : ['error'] as const;

// Auth schema client (Account, RefreshToken, OTP, AuditLog, LoggedInDevice)
export const authPrisma = new AuthPrismaClient({ log: [...logConfig] });

// UserOrg schema client (Account with extended fields, Friend, BlockedUser, Invitation, OrgSettings)
export const userorgPrisma = new UserOrgPrismaClient({ log: [...logConfig] });

// RBAC schema client (Role, Permission, UserRole, Department, Group)
export const rbacPrisma = new RBACPrismaClient({ log: [...logConfig] });

// Disconnect all clients
export async function disconnectAll() {
  await Promise.all([
    authPrisma.$disconnect(),
    userorgPrisma.$disconnect(),
    rbacPrisma.$disconnect(),
  ]);
}

// Connect all clients
export async function connectAll() {
  await Promise.all([
    authPrisma.$connect(),
    userorgPrisma.$connect(),
    rbacPrisma.$connect(),
  ]);

  try {
    await rbacPrisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_primary_dept_member 
      ON rbac.department_member (userId) 
      WHERE role IN ('HEAD', 'MANAGER', 'MEMBER');
    `);
  } catch (err: any) {
    console.warn('Could not create raw database unique index for primary department membership:', err.message);
  }
}
