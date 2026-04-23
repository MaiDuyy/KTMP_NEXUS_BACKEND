import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger.js';
import type { TokenPayload } from '@ott/shared';


declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      correlationId?: string;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_SECRET environment variable is missing in production!');
  }
  logger.warn('⚠️ Using default JWT_SECRET for development. DO NOT use this in production.');
}
const ACTIVE_JWT_SECRET = JWT_SECRET || 'dev-secret-change-in-production';

// JWT claims as they actually appear in tokens from auth-service
// (shared JwtPayload type is outdated — has wrong fields)
interface GatewayJwtClaims {
  sub: string;
  role: string;
  roles?: string[];
  roleLevel?: number;
  iat: number;
  exp: number;
}

// Public paths that bypass authentication (relative to /api mount point)
const PUBLIC_PATHS = new Set([
  '/auth/signup',
  '/auth/signin',
  '/auth/signin-phone',
  '/auth/verify-otp',
  '/auth/resend-otp',
  '/auth/refresh-token',
  '/otp/request',
  '/otp/resend',
  '/otp/verify',
]);


function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const cookieToken = req.cookies?.accessToken;
  if (cookieToken) {
    return cookieToken;
  }

  return null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'UNAUTHORIZED',
    });
  }

  try {
    const decoded = jwt.verify(token, ACTIVE_JWT_SECRET) as GatewayJwtClaims;
    req.user = {
      id: decoded.sub,
      role: decoded.role,
      roles: decoded.roles,
      roleLevel: decoded.roleLevel,
    };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        success: false,
        error: 'Token expired',
        code: 'TOKEN_EXPIRED',
      });
    }

    logger.warn({ error }, 'Invalid token');
    return res.status(401).json({
      success: false,
      error: 'Invalid token',
      code: 'INVALID_TOKEN',
    });
  }
}

export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);

  if (token) {
    try {
      const decoded = jwt.verify(token, ACTIVE_JWT_SECRET) as GatewayJwtClaims;
      req.user = {
        id: decoded.sub,
        role: decoded.role,
        roles: decoded.roles,
        roleLevel: decoded.roleLevel,
      };
    } catch (error) {
      logger.debug({ error }, 'Invalid optional token');
    }
  }

  next();
}

/**
 * Gateway auth strategy — public paths bypass, all others enforce auth.
 * Mounted as: app.use('/api', gatewayAuthMiddleware, proxyRoutes)
 * req.path is relative to /api mount point, e.g. '/auth/signin'
 */
export function gatewayAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  return authMiddleware(req, res, next);
}


export function roleMiddleware(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
    }

    const hasRole = allowedRoles.includes(req.user.role) || 
      (req.user.roles && req.user.roles.some((r: string) => allowedRoles.includes(r)));

    if (!hasRole) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
      });
    }

    next();
  };
}

export function permissionMiddleware(resource: string, action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Auth required' });
    }

    // SUPER_ADMIN bypasses all permission checks at gateway
    const roles = req.user.roles || [req.user.role];
    if (roles.includes('SUPER_ADMIN')) {
      return next();
    }

    // At the gateway level, we do a basic role-based preliminary check.
    // Full granular permission checking is enforced at the downstream microservice level
    // to avoid N+1 RBAC queries at the gateway.
    const roleLevel = req.user.roleLevel ?? 999;
    
    // Very basic mapping (could be extended)
    if (resource === 'audit' && roleLevel <= 2) return next(); // SECURITY_OFFICER or better
    if (resource === 'role' && roleLevel <= 1) return next(); // ORG_ADMIN or better
    
    // If the gateway doesn't explicitly authorize it, we still let the downstream
    // service make the final decision (downstream services use @ott/shared's requirePermission)
    next();
  };
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction) {
  const correlationId = req.headers['x-correlation-id'] as string || 
    `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);
  
  next();
}
