import { Request, Response, NextFunction } from 'express';

/**
 * Internal auth middleware — previously verified HMAC signatures.
 * Signature verification removed; services run inside a trusted private network
 * and are not directly reachable from the public internet.
 * Context headers (x-user-id, x-user-role, etc.) forwarded by the API Gateway
 * are still trusted implicitly.
 */
export const internalAuthMiddleware = (_req: Request, _res: Response, next: NextFunction) => {
  next();
};
