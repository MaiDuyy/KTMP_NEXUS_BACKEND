import type { PermissionClaim } from "./permission.types.js";

export interface JwtPayload {
  sub: string;
  email?: string;
  roles?: string[];
  permissions?: PermissionClaim[];
  iat?: number;
  exp?: number;
}

export interface AuthenticatedUser {
  id: string;
  email?: string;
  roles?: string[];
  permissions?: PermissionClaim[];
}
