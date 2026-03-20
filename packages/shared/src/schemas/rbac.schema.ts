import { z } from "zod";
import { uuidSchema } from "./common.schema.js";

export const permissionCheckSchema = z.object({
  resource: z.string().min(1),
  action: z.string().min(1),
  scope: z.string().optional(),
});

export const assignRoleSchema = z.object({
  userId: uuidSchema,
  roleId: uuidSchema,
  orgId: uuidSchema.optional(),
  workspaceId: uuidSchema.optional(),
});
