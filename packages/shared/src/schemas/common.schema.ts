import { z } from "zod";

export const uuidSchema = z.string().uuid("Invalid UUID");
export const emailSchema = z.string().email("Invalid email");
export const isoDateSchema = z.string().datetime({ message: "Invalid ISO date" });

export const idParamSchema = z.object({
  id: uuidSchema,
});
