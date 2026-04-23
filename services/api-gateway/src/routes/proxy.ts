// services/api-gateway/src/routes/proxy.ts
// Proxy routes to internal microservices

import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { roleMiddleware, permissionMiddleware } from '../middleware/auth.js';
import { createInternalSignature } from '@ott/shared';
        import { URL } from 'url';
import http from 'http';
import https from 'https';
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET;
if (!INTERNAL_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: INTERNAL_SERVICE_SECRET is missing in production!');
  }
  logger.warn('⚠️ Using default INTERNAL_SERVICE_SECRET for development. DO NOT use this in production.');
}
const ACTIVE_INTERNAL_SECRET = INTERNAL_SECRET || 'dev-internal-secret-change-in-production';

const router = Router();

const SERVICES = {
  // CONSOLIDATED: auth + user + rbac → identity-service (port 3010)
  IDENTITY: process.env.IDENTITY_SERVICE_URL || 'http://localhost:3010',
  // Legacy aliases — all point to IDENTITY
  AUTH: process.env.IDENTITY_SERVICE_URL || 'http://localhost:3010',
  USER: process.env.IDENTITY_SERVICE_URL || 'http://localhost:3010',
  RBAC: process.env.IDENTITY_SERVICE_URL || 'http://localhost:3010',
  // Other services unchanged
  MESSAGING: process.env.MESSAGING_SERVICE_URL || 'http://localhost:3020',
  FILE: process.env.FILE_SERVICE_URL || 'http://localhost:3014',
  STATS: process.env.STATS_SERVICE_URL || 'http://localhost:3015',
  AUDIT: process.env.AUDIT_SERVICE_URL || 'http://localhost:3017',
  KNOWLEDGE: process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:3018',
  NOTIFICATION: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3019',
  SPRING_AI: process.env.SPRING_AI_URL || 'http://localhost:8080',
};
async function forwardRequest(
  req: Request,
  res: Response,
  serviceUrl: string,
  path: string
) {
  try {
    const url = `${serviceUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

const user = (req as any).user;

let hmacPayload = { userId: '', role: '', roles: '', roleLevel: '' };

if (user) {
  headers["x-user-id"] = user.id;
  hmacPayload.userId = user.id;

  headers["x-user-role"] = user.role;
  hmacPayload.role = user.role;

  if (user.roles?.length) {
    const rolesStr = JSON.stringify(user.roles);
    headers["x-user-roles"] = rolesStr;
    hmacPayload.roles = rolesStr;
  }
  if (user.roleLevel !== undefined) {
    const levelStr = String(user.roleLevel);
    headers["x-user-role-level"] = levelStr;
    hmacPayload.roleLevel = levelStr;
  }
}

// Generate an HMAC signature to prove this traffic originated from the API Gateway
const signature = createInternalSignature(ACTIVE_INTERNAL_SECRET, hmacPayload);
headers['x-internal-signature'] = signature;

    const contentType = req.headers['content-type'];
    const isMultipart = contentType && contentType.toLowerCase().includes('multipart/form-data');

    if (isMultipart) {
      headers['Content-Type'] = contentType;
      if (req.headers['content-length']) {
        headers['Content-Length'] = req.headers['content-length'];
      }
    }

    if (req.headers.cookie) {
      headers['cookie'] = req.headers.cookie;
    }

    if ((req as any).correlationId) {
      headers['x-correlation-id'] = (req as any).correlationId;
    }

    if (isMultipart) {
      // Use native HTTP to pipe the stream flawlessly (fetch with toWeb() often corrupts multipart boundaries in express middlewares)
      return new Promise<void>((resolve, reject) => {

        
        const parsedUrl = new URL(url);
        const requestModule = parsedUrl.protocol === 'https:' ? https : http;
        
        const proxyReq = requestModule.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: req.method,
          headers,
        }, (proxyRes: any) => {
          res.status(proxyRes.statusCode || 200);
          // Copy response headers but skip CORS + hop-by-hop headers.
          // The gateway's own CORS middleware already set the correct
          // Access-Control-* headers for the browser — downstream services
          // may have different CORS origins that would overwrite and break them.
          const SKIP_HEADERS = new Set([
            'transfer-encoding',
            'access-control-allow-origin',
            'access-control-allow-credentials',
            'access-control-allow-methods',
            'access-control-allow-headers',
            'access-control-expose-headers',
            'access-control-max-age',
          ]);
          if (proxyRes.headers) {
            Object.keys(proxyRes.headers).forEach(key => {
              if (!SKIP_HEADERS.has(key.toLowerCase())) {
                res.setHeader(key, proxyRes.headers[key]);
              }
            });
          }
          proxyRes.pipe(res);
          
          proxyRes.on('end', () => resolve());
        });

        proxyReq.on('error', (err: Error) => {
          reject(err);
        });

        req.pipe(proxyReq);
      });
    }

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, fetchOptions);

    const data = await response.json();

    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      res.setHeader('Set-Cookie', setCookies);
    } else {
      const setCookieStr = response.headers.get('set-cookie');
      if (setCookieStr) {
        res.setHeader('Set-Cookie', setCookieStr);
      }
    }

    res.status(response.status).json(data);
  } catch (error: any) {
    logger.error({ error: error.message, serviceUrl, path }, 'Proxy error');
    res.status(503).json({
      success: false,
      message: 'Dịch vụ tạm thời không khả dụng',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}

// ============= AUTH ROUTES =============

router.post('/auth/signup', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/signup'));
router.post('/auth/signin', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/signin'));
router.post('/auth/signin-phone', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/signin-phone'));
router.post('/auth/signout', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/signout'));
router.post('/auth/refresh-token', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/refresh-token'));
router.post('/auth/verify-otp', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/verify-otp'));
router.post('/auth/resend-otp', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/resend-otp'));
router.put('/auth/change-password', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/change-password'));
router.get('/auth/check', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/check'));
router.get('/auth/me', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/me'));

// ============= USER ROUTES =============

// 1. Static routes (Exact matches)
router.get('/users/profile', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/profile'));
router.put('/users/profile', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/profile'));
router.get('/users/account', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/account'));
router.put('/users/account', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/account'));
router.put('/users/status', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/status'));
router.put('/users/online-status', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/online-status'));
router.post('/users/heartbeat', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/heartbeat'));
router.get('/users/devices', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/devices'));
router.get('/users/directory', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/users/directory${query ? `?${query}` : ''}`);
});
router.get('/users/batch/:ids', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/batch?ids=${req.params.ids}`));

// 2. User Status & Custom Status (Specific prefixes)
router.put('/users/user-status', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/user-status'));
router.put('/users/custom-status', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/custom-status'));
router.delete('/users/custom-status', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/custom-status'));

// 3. Admin routes
router.get('/users/admin/suspended', roleMiddleware('SUPER_ADMIN', 'ORG_ADMIN'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/users/admin/suspended${query ? `?${query}` : ''}`);
});
router.get('/admin/stats', roleMiddleware('SUPER_ADMIN', 'ORG_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, '/admin/stats'));

// 4. Base collection route
router.get('/users', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/users${query ? `?${query}` : ''}`);
});

// 5. Parameterized routes (/:id or /:id/...)
router.delete('/users/devices/:deviceId', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/devices/${req.params.deviceId}`));
router.get('/users/:id/status', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}/status`));
router.put('/users/:id/role', roleMiddleware('SUPER_ADMIN', 'ORG_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}/role`));
router.post('/users/:id/suspend', roleMiddleware('SUPER_ADMIN', 'ORG_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}/suspend`));
router.post('/users/:id/unsuspend', roleMiddleware('SUPER_ADMIN', 'ORG_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}/unsuspend`));

// 6. Generic ID routes (Place these LAST)
router.get('/users/:id', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}`));
router.put('/users/:id', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}`));
router.delete('/users/:id', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}`));


// ============= INVITATION ROUTES =============

router.get('/invitations', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/invitations${query ? `?${query}` : ''}`);
});
router.post('/invitations', (req, res) => forwardRequest(req, res, SERVICES.USER, '/invitations'));
router.get('/invitations/:id', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/invitations/${req.params.id}`));
router.post('/invitations/:id/resend', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/invitations/${req.params.id}/resend`));
router.delete('/invitations/:id', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/invitations/${req.params.id}`));

// ============= ORG SETTINGS ROUTES =============

// ============= FRIEND ROUTES =============
router.get('/friends', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/friends${query ? `?${query}` : ''}`);
});
router.get('/friends/requests/received', (req, res) => forwardRequest(req, res, SERVICES.USER, '/friends/requests/received'));
router.get('/friends/requests/sent', (req, res) => forwardRequest(req, res, SERVICES.USER, '/friends/requests/sent'));
router.post('/friends/request', (req, res) => forwardRequest(req, res, SERVICES.USER, '/friends/request'));
router.post('/friends/accept/:requestId', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/friends/accept/${req.params.requestId}`));
router.delete('/friends/reject/:requestId', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/friends/reject/${req.params.requestId}`));
router.delete('/friends/cancel/:requestId', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/friends/cancel/${req.params.requestId}`));
router.delete('/friends/:friendId', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/friends/${req.params.friendId}`));
router.post('/friends/block/:userId', (req, res) => forwardRequest(req, res, SERVICES.USER, `/friends/block/${req.params.userId}`));
router.delete('/friends/unblock/:userId', (req, res) => forwardRequest(req, res, SERVICES.USER, `/friends/unblock/${req.params.userId}`));
router.get('/friends/blocked', (req, res) => forwardRequest(req, res, SERVICES.USER, '/friends/blocked'));
router.get('/friends/search', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/friends/search${query ? `?${query}` : ''}`);
});



// ============= CHAT/GROUP/WORKSPACE/CHANNEL ROUTES → MESSAGING SERVICE =============
// All routes previously split between group-service and chat-service now go to messaging-service

['/workspaces', '/channels', '/categories'].forEach(prefix => {
  router.all(`${prefix}{*rest}`, (req, res) => {
    const query = Object.keys(req.query).length ? `?${new URLSearchParams(req.query as any).toString()}` : '';
    forwardRequest(req, res, SERVICES.MESSAGING, `${req.path}${query}`);
  });
});

router.get('/chats', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats${query ? `?${query}` : ''}`);
});
router.get('/chats/:chatId', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}`));
router.get('/chats/:chatId/call/token', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/call/token`));
router.get('/chats/:chatId/receipts', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/receipts`));
router.post('/chats/group', (req, res) => forwardRequest(req, res, SERVICES.MESSAGING, '/chats/group'));
router.post('/chats/private', (req, res) => forwardRequest(req, res, SERVICES.MESSAGING, '/chats/private'));
router.put('/chats/:chatId', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}`));
router.post('/chats/:chatId/members', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/members`));
router.delete('/chats/:chatId/members/:memberId', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/members/${req.params.memberId}`));
router.put('/chats/:chatId/members/:memberId/role', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/members/${req.params.memberId}/role`));
router.post('/chats/:chatId/leave', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/leave`));
router.put('/chats/:chatId/pin', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/pin`));
router.put('/chats/:chatId/notify', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/notify`));
router.put('/chats/:chatId/read', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/read`));
router.delete('/chats/:chatId', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}`));

// ============= JOIN & TASK ROUTES =============
router.post('/chats/:chatId/join', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/join`));
router.post('/chats/:chatId/join-requests/:targetAccountId/approve', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/join-requests/${req.params.targetAccountId}/approve`));
router.post('/chats/:chatId/tasks', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/tasks`));
router.get('/chats/:chatId/tasks', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/${req.params.chatId}/tasks`));
router.patch('/chats/tasks/:taskId/status', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/tasks/${req.params.taskId}/status`));
router.delete('/chats/tasks/:taskId', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/chats/tasks/${req.params.taskId}`));

// ============= MESSAGE ROUTES → MESSAGING SERVICE =============

router.get('/messages/:chatId', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.chatId}${query ? `?${query}` : ''}`);
});
router.post('/messages/:chatId', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.chatId}`));
router.delete('/messages/:messageId', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.messageId}`));
router.delete('/messages/:messageId/recall', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.messageId}/recall`));
router.post('/messages/:messageId/react', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.messageId}/react`));
router.put('/messages/:messageId/pin', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.messageId}/pin`));
router.get('/messages/:chatId/pinned', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.chatId}/pinned`));
router.get('/messages/:chatId/search', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.chatId}/search${query ? `?${query}` : ''}`);
});
router.get('/messages/:chatId/media', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.chatId}/media${query ? `?${query}` : ''}`);
});

// ============= FILE ROUTES =============

// Proxy all file upload/download routes to the FILE service
// Express 5 uses {*rest} syntax for catch-all wildcards
router.all('/upload', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.FILE, `/upload${query ? `?${query}` : ''}`);
});

router.all('/upload/{*rest}', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.FILE, `${req.path}${query ? `?${query}` : ''}`);
});

// ============= STATS ROUTES =============

router.get('/stats', (req, res) => forwardRequest(req, res, SERVICES.STATS, '/'));
router.get('/stats/users/:userId', (req, res) => 
  forwardRequest(req, res, SERVICES.STATS, `/users/${req.params.userId}`));
router.get('/stats/chats/:chatId', (req, res) => 
  forwardRequest(req, res, SERVICES.STATS, `/chats/${req.params.chatId}`));
router.get('/stats/daily', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.STATS, `/daily${query ? `?${query}` : ''}`);
});

// ============= RBAC ROUTES =============
router.use('/rbac', roleMiddleware('SUPER_ADMIN', 'ORG_ADMIN'));

router.get('/rbac/roles', (req, res) => forwardRequest(req, res, SERVICES.RBAC, '/roles'));
router.get('/rbac/roles/:id', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/roles/${req.params.id}`));
router.post('/rbac/roles', (req, res) => forwardRequest(req, res, SERVICES.RBAC, '/roles'));
router.put('/rbac/roles/:id', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/roles/${req.params.id}`));
router.delete('/rbac/roles/:id', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/roles/${req.params.id}`));
router.get('/rbac/permissions', (req, res) => forwardRequest(req, res, SERVICES.RBAC, '/permissions'));
router.post('/rbac/roles/:id/permissions', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/roles/${req.params.id}/permissions`));
router.delete('/rbac/roles/:id/permissions', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/roles/${req.params.id}/permissions`));
router.get('/rbac/users/:userId/roles', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/users/${req.params.userId}/roles`));
router.get('/rbac/users/:userId/permissions', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/users/${req.params.userId}/permissions`));
router.post('/rbac/users/:userId/roles', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/users/${req.params.userId}/roles`));
router.delete('/rbac/users/:userId/roles/:roleId', (req, res) =>
  forwardRequest(req, res, SERVICES.RBAC, `/users/${req.params.userId}/roles/${req.params.roleId}`));
router.post('/rbac/check', (req, res) => forwardRequest(req, res, SERVICES.RBAC, '/check'));
router.post('/rbac/check-role', (req, res) => forwardRequest(req, res, SERVICES.RBAC, '/check-role'));

// ============= AUDIT ROUTES =============
router.use('/audit', roleMiddleware('SUPER_ADMIN', 'SECURITY_OFFICER'));

router.post('/audit/logs', (req, res) => forwardRequest(req, res, SERVICES.AUDIT, '/logs'));
router.get('/audit/logs', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/logs${query ? `?${query}` : ''}`);
});
router.get('/audit/logs/:id', (req, res) =>
  forwardRequest(req, res, SERVICES.AUDIT, `/logs/${req.params.id}`));
router.get('/audit/users/:userId/logs', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/users/${req.params.userId}/logs${query ? `?${query}` : ''}`);
});
router.get('/audit/resources/:resource/:resourceId/logs', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/resources/${req.params.resource}/${req.params.resourceId}/logs${query ? `?${query}` : ''}`);
});
router.get('/audit/alerts', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/alerts${query ? `?${query}` : ''}`);
});
router.post('/audit/alerts', (req, res) => forwardRequest(req, res, SERVICES.AUDIT, '/alerts'));
router.put('/audit/alerts/:id/resolve', (req, res) =>
  forwardRequest(req, res, SERVICES.AUDIT, `/alerts/${req.params.id}/resolve`));
router.get('/audit/dm-access', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/dm-access${query ? `?${query}` : ''}`);
});
router.post('/audit/dm-access', (req, res) => forwardRequest(req, res, SERVICES.AUDIT, '/dm-access'));
router.get('/audit/reports', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/reports${query ? `?${query}` : ''}`);
});
router.post('/audit/reports', (req, res) => forwardRequest(req, res, SERVICES.AUDIT, '/reports'));

// ============= KNOWLEDGE ROUTES (Direct to Spring AI) =============
// These proxy directly to the Spring Boot ai-knowledge service (API/DB)
// eliminating the need for the Node.js knowledge-service.

// Spring: Document CRUD
router.get('/documents', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/documents'));
router.get('/documents/:id', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}`));
router.post('/documents/upload', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/documents/upload'));
router.delete('/documents/:id', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}`));

// Spring: Chunks & Stats
router.get('/documents/:id/chunks', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/chunks`));
router.get('/documents/:id/chunks/:chunkIndex', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/chunks/${req.params.chunkIndex}`));
router.get('/documents/:id/stats', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/stats`));

// Spring: Semantic Search
router.post('/documents/search', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/documents/search'));

// Spring: Chat / Conversations
router.post('/chat/conversations', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/chat/conversations'));
router.get('/chat/conversations', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/chat/conversations'));
router.get('/chat/conversations/:id/messages', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/chat/conversations/${req.params.id}/messages`));
router.delete('/chat/conversations/:id', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/chat/conversations/${req.params.id}`));
router.post('/chat/messages', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/chat/messages'));

// Spring: Dashboard
router.get('/dashboard/daily-brief', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/dashboard/daily-brief'));

router.get('/dashboard/system-health', async (_req, res) => {
  const servicesToPing = [
    { name: 'Identity Service', url: SERVICES.IDENTITY },
    { name: 'Messaging Service', url: SERVICES.MESSAGING },
    { name: 'AI Service', url: SERVICES.SPRING_AI }
  ];

  const results = await Promise.all(servicesToPing.map(async (svc) => {
    const start = Date.now();
    try {
      const response = await fetch(`${svc.url}/healthz`, { method: 'GET', signal: AbortSignal.timeout(3000) });
      const ping = Date.now() - start;
      return {
        name: svc.name,
        status: response.ok ? 'healthy' : 'degraded',
        ping: `${ping}ms`
      };
    } catch (e) {
      return {
        name: svc.name,
        status: 'offline',
        ping: 'timeout'
      };
    }
  }));

  res.json({
    services: results,
    timestamp: new Date().toISOString()
  });
});

// ============= NOTIFICATION ROUTES =============

router.get('/notifications/:userId', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${req.params.userId}${query ? `?${query}` : ''}`);
});
router.get('/notifications/:userId/unread-count', (req, res) =>
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${req.params.userId}/unread-count`));
router.patch('/notifications/:notificationId/read', (req, res) =>
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${req.params.notificationId}/read`));
router.patch('/notifications/:userId/read-all', (req, res) =>
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${req.params.userId}/read-all`));
router.delete('/notifications/:notificationId', (req, res) =>
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${req.params.notificationId}`));
router.post('/notifications/push-tokens', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/push-tokens'));
router.delete('/notifications/push-tokens/:token', (req, res) =>
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/push-tokens/${req.params.token}`));

// OTP
router.post('/otp/request', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/otp/request'));
router.post('/otp/resend', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/otp/resend'));
router.post('/otp/verify', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/otp/verify'));

export const proxyRoutes = router;

