export type PermissionScope = "own" | "team" | "department" | "org" | "system";

export interface PermissionClaim {
  resource: string;
  action: string;
  scope?: PermissionScope;
}

export interface PermissionCheckInput {
  resource: string;
  action: string;
  scope?: PermissionScope;
}
