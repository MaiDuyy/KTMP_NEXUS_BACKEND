import type { Request, Response, NextFunction } from "express";
import type { PermissionScope, PermissionClaim } from "../types/permission.types.js";

function hasPermission(
  claims: PermissionClaim[] | undefined,
  resource: string,
  action: string,
  scope?: PermissionScope
) {
  if (!claims || claims.length === 0) return false;
  return claims.some(
    (p) =>
      p.resource === resource &&
      p.action === action &&
      (scope ? p.scope === scope : true)
  );
}

export function requirePermission(
  resource: string,
  action: string,
  scope?: PermissionScope
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    if (!hasPermission(user.permissions, resource, action, scope)) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    return next();
  };
}
