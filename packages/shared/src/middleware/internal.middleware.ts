import { Request, Response, NextFunction } from 'express';
import { verifyInternalSignature } from '../utils/hmac.js';

export const internalAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Allow bypassing if explicitly marked as a public route inside a microservice
  // (though ideally, all external access goes through gateway, and gateway drops unauthenticated requests already)
  
  const signature = req.headers['x-internal-signature'] as string;
  const userId = req.headers['x-user-id'] as string;
  const role = req.headers['x-user-role'] as string;
  const roles = req.headers['x-user-roles'] as string;
  const roleLevel = req.headers['x-user-role-level'] as string;

  let internalSecret = process.env.INTERNAL_SERVICE_SECRET;
  
  if (!internalSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: INTERNAL_SERVICE_SECRET is missing on the microservice in production!');
      return res.status(500).json({ success: false, error: 'Internal configuration error' });
    }
    console.warn('⚠️ Using default INTERNAL_SERVICE_SECRET for development.');
    internalSecret = 'dev-internal-secret-change-in-production';
  }

  // If there's no user data attached (like anonymous public routes), there might still be an anonymous signature?
  // Our gateway always attaches it, even if anonymous.
  if (!signature) {
    return res.status(403).json({
      success: false,
      error: 'Missing internal signature. Are you bypassing the API Gateway?',
    });
  }

  const isValid = verifyInternalSignature(internalSecret, signature, {
    userId,
    role,
    roles,
    roleLevel,
  });

  if (!isValid) {
    console.warn(`SECURITY ALERT: Invalid internal signature detected for user ${userId || 'anonymous'}`);
    return res.status(403).json({
      success: false,
      error: 'Invalid internal request signature',
    });
  }

  next();
};
