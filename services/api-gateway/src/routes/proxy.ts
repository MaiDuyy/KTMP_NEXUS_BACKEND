// services/api-gateway/src/routes/proxy.ts
// Proxy routes to internal microservices

import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { roleMiddleware, permissionMiddleware } from '../middleware/auth.js';
import { URL } from 'url';
import http from 'http';
import https from 'https';

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
  AUDIT: process.env.IDENTITY_SERVICE_URL || 'http://localhost:3010',
  KNOWLEDGE: process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:3018',
  NOTIFICATION: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3019',

  SPRING_AI: process.env.SPRING_AI_URL || 'http://localhost:8080',
  WS_GATEWAY: process.env.WS_GATEWAY_URL || 'http://localhost:3001',
  VOICE: process.env.VOICE_SERVICE_URL || 'http://localhost:3035',
};

const MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024;

function forwardVoiceAudio(req: Request, res: Response, turnId: string): void {
  const contentType = req.headers['content-type'];
  const contentLength = Number(req.headers['content-length']);
  if (!contentType || (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream')) {
    res.status(415).json({ code: 'VOICE_AUDIO_FORMAT_UNSUPPORTED' });
    return;
  }
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_VOICE_AUDIO_BYTES) {
    res.status(413).json({ code: 'VOICE_AUDIO_TOO_LARGE' });
    return;
  }

  const target = new URL(`${SERVICES.VOICE}/v1/voice/turns/${encodeURIComponent(turnId)}/audio`);
  const requestModule = target.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { 'content-type': contentType, 'content-length': String(contentLength) };
  if (typeof req.headers.authorization === 'string') headers.authorization = req.headers.authorization;
  if (typeof req.headers['x-request-id'] === 'string') headers['x-request-id'] = req.headers['x-request-id'];

  const proxyRequest = requestModule.request({
    hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers, timeout: 60_000,
  }, (proxyResponse) => {
    res.status(proxyResponse.statusCode || 502);
    if (proxyResponse.headers['content-type']) res.setHeader('content-type', proxyResponse.headers['content-type']);
    proxyResponse.pipe(res);
  });
  proxyRequest.on('timeout', () => proxyRequest.destroy(new Error('voice upload timed out')));
  proxyRequest.on('error', () => {
    if (!res.headersSent) res.status(503).json({ code: 'VOICE_INTERNAL_ERROR' });
  });
  req.pipe(proxyRequest);
}
async function forwardRequest(
  req: Request,
  res: Response,
  serviceUrl: string,
  path: string,
  options?: { method?: string; body?: any; headers?: Record<string, string> }
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

// Generate internal request headers to identify this traffic originated from the API Gateway

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

    const forwardedFor = req.headers['x-forwarded-for'] as string || req.ip || req.socket.remoteAddress || '';
    if (forwardedFor) {
      headers['x-forwarded-for'] = forwardedFor;
    }

    const wsId = req.headers['x-workspace-id'] as string;
    if (wsId) {
      headers['x-workspace-id'] = wsId;
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
          method: options?.method || req.method,
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

    const finalMethod = options?.method || req.method;
    const fetchOptions: RequestInit = {
      method: finalMethod,
      headers,
    };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(finalMethod)) {
      fetchOptions.body = JSON.stringify(options?.body || req.body);
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

/**
 * Specialized forwarder for multipart/form-data (file uploads)
 * Pipes the raw request stream to the target service.
 */
async function forwardMultipartRequest(
  req: Request,
  res: Response,
  serviceUrl: string,
  path: string
) {
  try {
    const targetUrl = new URL(`${serviceUrl}${path}`);
    const user = (req as any).user;

    const headers = { ...req.headers };
    // Remove host to avoid conflicts
    delete headers.host;
    delete headers.connection;

    if (user) {
      headers['x-user-id'] = user.id;
      headers['x-user-role'] = user.role || '';
    }

    const wsId = req.headers['x-workspace-id'] as string;
    if (wsId) {
        headers['x-workspace-id'] = wsId;
    }

    const protocol = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = protocol.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: headers as any,
      },
      (proxyRes) => {
        res.status(proxyRes.statusCode || 500);
        // Skip CORS + hop-by-hop headers — the Gateway's own CORS middleware
        // already set the correct Access-Control-* for the browser.
        // Copying them from the downstream service (which may use '*') would
        // overwrite the gateway's credential-safe origin and break the request.
        const SKIP_HEADERS = new Set([
          'transfer-encoding',
          'access-control-allow-origin',
          'access-control-allow-credentials',
          'access-control-allow-methods',
          'access-control-allow-headers',
          'access-control-expose-headers',
          'access-control-max-age',
        ]);
        Object.entries(proxyRes.headers).forEach(([key, value]) => {
          if (value && !SKIP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
        });
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      logger.error({ err: err.message, serviceUrl, path }, 'Multipart proxy error');
      res.status(503).json({ success: false, message: 'Dịch vụ upload tạm thời không khả dụng' });
    });

    req.pipe(proxyReq);
  } catch (error: any) {
    logger.error({ error: error.message, serviceUrl, path }, 'Multipart forward error');
    res.status(500).json({ success: false, message: 'Internal server error during upload' });
  }
}

/**
 * Forward a request and pipe the SSE / streaming response back to the client.
 * Used for AI agent and RAG endpoints that return text/event-stream.
 */
async function forwardStreamRequest(
  req: Request,
  res: Response,
  serviceUrl: string,
  path: string
) {
  try {
    const url = `${serviceUrl}${path}`;
    const user = (req as any).user;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (user) {
      headers['x-user-id'] = user.id;
      headers['x-user-role'] = user.role || '';
      if (user.roles?.length) {
        headers['x-user-roles'] = JSON.stringify(user.roles);
      }
      if (user.roleLevel !== undefined) {
        headers['x-user-role-level'] = String(user.roleLevel);
      }
    }

    if ((req as any).correlationId) {
      headers['x-correlation-id'] = (req as any).correlationId;
    }

    const wsId = req.headers['x-workspace-id'] as string;
    if (wsId) {
      headers['x-workspace-id'] = wsId;
    }

    const response = await fetch(url, {
      method: req.method,
      headers,
      body: ['POST', 'PUT', 'PATCH'].includes(req.method)
        ? JSON.stringify(req.body)
        : undefined,
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => 'Unknown error');
      logger.error({ status: response.status, url, errorText }, 'Stream proxy error');
      return res.status(response.status).json({ success: false, message: errorText });
    }

    const acceptHeader = req.headers['accept'] || '';
    const isClientExpectingStream = acceptHeader.includes('text/event-stream');

    if (isClientExpectingStream) {
      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();
    }

    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        if (isClientExpectingStream) {
          res.write(chunk);
        } else {
          // Flatten SSE to JSON for standard REST clients
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const content = line.replace(/^data:\s*/, '');
              if (content && content !== '[DONE]') {
                fullContent += content;
              }
            } else if (!line.startsWith('event:') && !line.startsWith('id:') && line.trim()) {
              fullContent += line;
            }
          }
        }
      }
    } finally {
      if (isClientExpectingStream) {
        res.end();
      } else {
        res.json({
          content: fullContent.trim(),
          role: 'assistant',
          success: true
        });
      }
    }
  } catch (error: any) {
    logger.error({ error: error.message, serviceUrl, path }, 'Stream proxy error');
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        message: 'Dịch vụ AI tạm thời không khả dụng',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
}


router.post('/auth/register-organization', (req, res) => forwardRequest(req, res, SERVICES.AUTH, '/register-organization'));
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
router.post('/users/provision', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.USER, '/users/provision'));
router.get('/users/devices', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/devices'));
router.get('/users/directory', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/users/directory${query ? `?${query}` : ''}`);
});
router.get('/users/batch/:ids', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.USER, `/users/batch?ids=${req.params.ids}`));

// 2. User Status & Custom Status (Specific prefixes)
router.put('/users/user-status', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/user-status'));
router.put('/users/custom-status', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/custom-status'));
router.delete('/users/custom-status', (req, res) => forwardRequest(req, res, SERVICES.USER, '/users/custom-status'));

// 3. Admin routes
router.get('/users/admin/suspended', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/users/admin/suspended${query ? `?${query}` : ''}`);
});
router.get('/admin/stats', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, '/admin/stats'));
router.post('/admin/broadcast', roleMiddleware('SUPER_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, '/admin/broadcast'));

// Organization Admin Routes
router.get('/admin/organizations', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/admin/organizations${query ? `?${query}` : ''}`);
});
router.patch('/admin/organizations/:orgId/quota', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/admin/organizations/${req.params.orgId}/quota`));
router.patch('/admin/users/:userId/quota', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/admin/users/${req.params.userId}/quota`));

// 4. Base collection route
router.get('/users', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/users${query ? `?${query}` : ''}`);
});
router.post('/users', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.USER, '/users'));

// 5. Parameterized routes (/:id or /:id/...)
router.delete('/users/devices/:deviceId', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/devices/${req.params.deviceId}`));
router.get('/users/:id/status', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}/status`));
router.put('/users/:id/role', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}/role`));
router.post('/users/:id/suspend', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}/suspend`));
router.post('/users/:id/unsuspend', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}/unsuspend`));

router.get('/users/:userId/departments', (req, res) => 
  forwardRequest(req, res, SERVICES.IDENTITY, `/users/${req.params.userId}/departments`));

// 6. Generic ID routes (Place these LAST)
router.get('/users/:id', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}`));
router.put('/users/:id', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}`));
router.delete('/users/:id', (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/users/${req.params.id}`));


// ============= INVITATION ROUTES =============

router.get('/invitations', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.USER, `/invitations${query ? `?${query}` : ''}`);
});
router.post('/invitations', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => forwardRequest(req, res, SERVICES.USER, '/invitations'));
router.get('/invitations/:id', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/invitations/${req.params.id}`));
router.post('/invitations/:id/resend', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/invitations/${req.params.id}/resend`));
router.delete('/invitations/:id', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => 
  forwardRequest(req, res, SERVICES.USER, `/invitations/${req.params.id}`));

// Public invitation routes (matched by prefix in auth middleware)
router.get('/invitations/validate/:token', (req, res) => forwardRequest(req, res, SERVICES.USER, `/invitations/validate/${req.params.token}`));
router.post('/invitations/accept/:token', (req, res) => forwardRequest(req, res, SERVICES.USER, `/invitations/accept/${req.params.token}`));
router.post('/invitations/join/:token', (req, res) => forwardRequest(req, res, SERVICES.USER, `/invitations/join/${req.params.token}`));

// ============= ORG SETTINGS ROUTES =============
router.get('/org-settings', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => forwardRequest(req, res, SERVICES.USER, '/org-settings'));
router.put('/org-settings', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_OWNER', 'WORKSPACE_ADMIN'), (req, res) => forwardRequest(req, res, SERVICES.USER, '/org-settings'));

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

// Explicit Workspace Management & Invite Routes (Redirected to IDENTITY for unified RBAC)
router.post('/workspaces/:id/invites', (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, '/invitations', {
  body: { ...req.body, workspaceId: req.params.id }
}));
router.get('/workspaces/:id/invites', (req, res) => 
  forwardRequest(req, res, SERVICES.IDENTITY, `/invitations?workspaceId=${req.params.id}`));
router.delete('/workspaces/invites/:inviteId', (req, res) => 
  forwardRequest(req, res, SERVICES.IDENTITY, `/invitations/${req.params.inviteId}`));
router.post('/workspaces/invites/:inviteId/resend', (req, res) =>
  forwardRequest(req, res, SERVICES.IDENTITY, `/invitations/${req.params.inviteId}/resend`));

router.get('/workspaces/invites/validate/:token', (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, `/invitations/validate/${req.params.token}`));
router.post('/workspaces/invites/accept', (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, '/invitations/accept-body'));
router.post('/workspaces/invites/join', (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, '/invitations/join-body'));
router.post('/workspaces/invites/reject', (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, '/invitations/reject-body'));

// Explicit Workspace Lifecycle Routes (Go to IDENTITY)
router.post('/workspaces/:id/dissolve', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MANAGER', 'EMPLOYEE'), (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, `/workspaces/${req.params.id}/dissolve`));
router.post('/workspaces/:id/restore', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MANAGER', 'EMPLOYEE'), (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, `/workspaces/${req.params.id}/restore`));
router.post('/workspaces/:id/leave', (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, `/workspaces/${req.params.id}/leave`));

router.all(/^\/workspaces/, (req, res) => {
  const query = Object.keys(req.query).length ? `?${new URLSearchParams(req.query as any).toString()}` : '';
  forwardRequest(req, res, SERVICES.MESSAGING, `${req.path}${query}`);
});

router.all(/^\/channels/, (req, res) => {
  const query = Object.keys(req.query).length ? `?${new URLSearchParams(req.query as any).toString()}` : '';
  forwardRequest(req, res, SERVICES.MESSAGING, `${req.path}${query}`);
});

router.all(/^\/categories/, (req, res) => {
  const query = Object.keys(req.query).length ? `?${new URLSearchParams(req.query as any).toString()}` : '';
  forwardRequest(req, res, SERVICES.MESSAGING, `${req.path}${query}`);
});

// Organization Routes -> IDENTITY
router.all(/^\/departments/, (req, res) => {
  const query = Object.keys(req.query).length ? `?${new URLSearchParams(req.query as any).toString()}` : '';
  forwardRequest(req, res, SERVICES.IDENTITY, `${req.path}${query}`);
});

router.all(/^\/groups/, (req, res) => {
  const query = Object.keys(req.query).length ? `?${new URLSearchParams(req.query as any).toString()}` : '';
  forwardRequest(req, res, SERVICES.IDENTITY, `${req.path}${query}`);
});

// Workspace Member Management
router.get('/workspaces/:id/members', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.MESSAGING, `/workspaces/${req.params.id}/members${query ? `?${query}` : ''}`);
});
router.put('/workspaces/:id/members/:targetUserId', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/workspaces/${req.params.id}/members/${req.params.targetUserId}`));
router.post('/workspaces/:id/transfer-ownership', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, `/workspaces/${req.params.id}/transfer-ownership`));
router.delete('/workspaces/:id/members/:targetUserId', (req, res) => 
  forwardRequest(req, res, SERVICES.IDENTITY, `/workspaces/${req.params.id}/members/${req.params.targetUserId}`));
router.delete('/workspaces/:id', (req, res) => forwardRequest(req, res, SERVICES.MESSAGING, `/workspaces/${req.params.id}`));

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

// ============= POLLS ROUTES → MESSAGING SERVICE =============
router.post('/polls', (req, res) => forwardRequest(req, res, SERVICES.MESSAGING, '/polls'));
router.get('/polls/:pollId', (req, res) => forwardRequest(req, res, SERVICES.MESSAGING, `/polls/${req.params.pollId}`));
router.post('/polls/:pollId/vote', (req, res) => forwardRequest(req, res, SERVICES.MESSAGING, `/polls/${req.params.pollId}/vote`));
router.post('/polls/:pollId/end', (req, res) => forwardRequest(req, res, SERVICES.MESSAGING, `/polls/${req.params.pollId}/end`));

// ============= MESSAGE ROUTES → MESSAGING SERVICE =============

router.get('/messages/:chatId', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.chatId}${query ? `?${query}` : ''}`);
});
router.post('/messages/forward', (req, res) => 
  forwardRequest(req, res, SERVICES.MESSAGING, '/messages/forward'));

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
router.get('/messages/:chatId/search', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.chatId}/search${query ? `?${query}` : ''}`);
});
router.get('/messages/:chatId/media', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.MESSAGING, `/messages/${req.params.chatId}/media${query ? `?${query}` : ''}`);
});

// ============= FILE ROUTES =============

// Voice audio is raw binary: keep it out of JSON/multipart forwarding paths.
router.post('/voice/turns/:turnId/audio', (req, res) => forwardVoiceAudio(req, res, req.params.turnId));

// Proxy all file upload/download routes to the FILE service
// Express 5 uses {*rest} syntax for catch-all wildcards
router.all('/upload', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardMultipartRequest(req, res, SERVICES.FILE, `/upload${query ? `?${query}` : ''}`);
});

router.all(/^\/upload/, (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardMultipartRequest(req, res, SERVICES.FILE, `${req.path}${query ? `?${query}` : ''}`);
});

// ============= STATS ROUTES =============

router.get('/stats', roleMiddleware('SUPER_ADMIN', 'ADMIN'), (req, res) => forwardRequest(req, res, SERVICES.STATS, '/'));
router.get('/stats/users/:userId', (req, res) => 
  forwardRequest(req, res, SERVICES.STATS, `/users/${req.params.userId}`));
router.get('/stats/chats/:chatId', (req, res) => 
  forwardRequest(req, res, SERVICES.STATS, `/chats/${req.params.chatId}`));
router.get('/stats/daily', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.STATS, `/daily${query ? `?${query}` : ''}`);
});

// ============= RBAC ROUTES =============
router.use('/rbac', roleMiddleware('SUPER_ADMIN', 'ADMIN'));

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
router.use('/audit', roleMiddleware('SUPER_ADMIN', 'ADMIN')); // Security level roles integrated into Admin

router.post('/audit/logs', (req, res) => forwardRequest(req, res, SERVICES.AUDIT, '/audit/logs'));
router.get('/audit/logs', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/audit/logs${query ? `?${query}` : ''}`);
});
router.get('/audit/logs/:id', (req, res) =>
  forwardRequest(req, res, SERVICES.AUDIT, `/audit/logs/${req.params.id}`));
router.get('/audit/users/:userId/logs', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/audit/users/${req.params.userId}/logs${query ? `?${query}` : ''}`);
});
router.get('/audit/resources/:resource/:resourceId/logs', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/audit/resources/${req.params.resource}/${req.params.resourceId}/logs${query ? `?${query}` : ''}`);
});
router.get('/audit/alerts', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/audit/alerts${query ? `?${query}` : ''}`);
});
router.post('/audit/alerts', (req, res) => forwardRequest(req, res, SERVICES.AUDIT, '/audit/alerts'));
router.put('/audit/alerts/:id/resolve', (req, res) =>
  forwardRequest(req, res, SERVICES.AUDIT, `/audit/alerts/${req.params.id}/resolve`));
router.get('/audit/dm-access', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/audit/dm-access${query ? `?${query}` : ''}`);
});
router.post('/audit/dm-access', (req, res) => forwardRequest(req, res, SERVICES.AUDIT, '/audit/dm-access'));
router.get('/audit/reports', (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.AUDIT, `/audit/reports${query ? `?${query}` : ''}`);
});
router.post('/audit/reports', (req, res) => forwardRequest(req, res, SERVICES.AUDIT, '/audit/reports'));

// ============= KNOWLEDGE ROUTES (Direct to Spring AI) =============
// These proxy directly to the Spring Boot ai-knowledge service (API/DB)
// eliminating the need for the Node.js knowledge-service.

// Spring: MRP (Map-Reduce-Plan) & Wiki Review Pipeline
router.post('/mrp/compile', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/compile${query ? `?${query}` : ''}`);
});

router.post('/mrp/plan/:planId/approve', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/plan/${req.params.planId}/approve${query ? `?${query}` : ''}`);
});

router.get('/mrp/plans', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/plans${query ? `?${query}` : ''}`);
});

router.get('/mrp/plans/:planId', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/plans/${req.params.planId}`));

router.get('/mrp/drafts', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/drafts${query ? `?${query}` : ''}`);
});

router.get('/mrp/drafts/workspace/:workspaceId', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/drafts/workspace/${req.params.workspaceId}`));

router.post('/mrp/drafts/:draftId/approve', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/drafts/${req.params.draftId}/approve`));

router.post('/mrp/drafts/:draftId/reject', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/drafts/${req.params.draftId}/reject`));

router.post('/mrp/drafts/:draftId/request-changes', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/drafts/${req.params.draftId}/request-changes`));

router.get('/mrp/wiki', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/wiki${query ? `?${query}` : ''}`);
});

router.get('/mrp/wiki/metadata', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/wiki/metadata${query ? `?${query}` : ''}`);
});

router.get(/^\/mrp\/wiki\/slug\/(.+)$/, roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  const slug = req.params[0];
  const query = new URLSearchParams(req.query as any).toString();
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/wiki/slug/${slug}${query ? `?${query}` : ''}`);
});

router.get('/mrp/wiki/id/:id', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/api/mrp/wiki/id/${req.params.id}`));

// Spring: Wiki Images
router.post('/wiki/images/resolve', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  return forwardRequest(req, res, SERVICES.SPRING_AI, '/api/wiki/images/resolve');
});

router.get('/wiki/images/raw/:id', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/api/wiki/images/raw/${req.params.id}`);
});

// Spring: Document CRUD
router.get('/documents', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  return forwardRequest(req, res, SERVICES.SPRING_AI, `/documents${query ? `?${query}` : ''}`);
});
router.get('/documents/:id', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}`));
router.get('/documents/:id/raw', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardMultipartRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/raw`));
router.post('/documents/upload', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) => {
  const query = new URLSearchParams(req.query as any).toString();
  return forwardMultipartRequest(req, res, SERVICES.SPRING_AI, `/documents/upload${query ? `?${query}` : ''}`);
});
router.post('/documents/:id/ingest', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/ingest`));
router.delete('/documents/:id', roleMiddleware('SUPER_ADMIN', 'ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}`));
router.patch('/documents/:id/metadata', roleMiddleware('SUPER_ADMIN', 'ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/metadata`));
router.post('/documents/:id/approve', roleMiddleware('SUPER_ADMIN', 'ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/approve`));
router.post('/documents/:id/ai-refactor', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/ai-refactor`));

// Spring: Chunks & Stats
router.get('/documents/:id/chunks', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/chunks`));
router.get('/documents/:id/chunks/:chunkIndex', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/chunks/${req.params.chunkIndex}`));
router.get('/documents/:id/stats', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/documents/${req.params.id}/stats`));

// Spring: Semantic Search
router.post('/documents/search', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/documents/search'));

// Spring: Chat / Conversations
router.post('/chat/conversations', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/chat/conversations'));
router.get('/chat/conversations', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/chat/conversations'));
router.get('/chat/conversations/:id/messages', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/chat/conversations/${req.params.id}/messages`));
router.delete('/chat/conversations/:id', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, `/chat/conversations/${req.params.id}`));
router.post('/chat/messages', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardStreamRequest(req, res, SERVICES.SPRING_AI, '/chat/messages'));

// ============= AI AGENT ROUTES (Spring) =============
router.post('/agent/chat', roleMiddleware('SUPER_ADMIN', 'ADMIN', 'WORKSPACE_MEMBER', 'EMPLOYEE'), (req, res) =>
  forwardStreamRequest(req, res, SERVICES.SPRING_AI, '/agent/chat'));
router.get('/agent/health', (req, res) =>
  forwardRequest(req, res, SERVICES.SPRING_AI, '/agent/health'));


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
// Messaging: Dashboard Tasks & Recent Files
router.get('/dashboard/tasks', (req, res) =>
  forwardRequest(req, res, SERVICES.MESSAGING, '/dashboard/tasks'));
router.patch('/dashboard/tasks/:taskId', (req, res) =>
  forwardRequest(req, res, SERVICES.MESSAGING, `/dashboard/tasks/${req.params.taskId}`));
router.get('/dashboard/recent-files', (req, res) =>
  forwardRequest(req, res, SERVICES.MESSAGING, '/dashboard/recent-files'));

// ============= NOTIFICATION ROUTES =============

// Get notifications (clean URL for frontend)
router.get('/notifications', (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const query = new URLSearchParams(req.query as any).toString();
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${userId}${query ? `?${query}` : ''}`);
});

// Get unread count (clean URL for frontend)
router.get('/notifications/unread-count', (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${userId}/unread-count`);
});

// Mark as read (both PUT and PATCH, and both notificationId and userId variants)
router.all('/notifications/:id/read', (req, res) => {
  // If :id is a userId, it's read-all. If it's a notificationId, it's single.
  // But usually frontend calls /notifications/:notificationId/read or /notifications/read-all
  const userId = (req as any).user?.id;
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${req.params.id}/read`, {
    method: 'PATCH',
    body: { ...req.body, userId } // Ensure userId is passed for single mark as read
  });
});

// Read all (clean URL)
router.all('/notifications/read-all', (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${userId}/read-all`, { method: 'PATCH' });
});

router.delete('/notifications/:notificationId', (req, res) => {
  const userId = (req as any).user?.id;
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${req.params.notificationId}`, {
    method: 'DELETE',
    body: { ...req.body, userId }
  });
});

// Clear all notifications
router.delete('/notifications', (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${userId}/all`, { method: 'DELETE' });
});

// Delete read notifications only
router.delete('/notifications/read', (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${userId}/read`, { method: 'DELETE' });
});

// Delete notifications by category
router.delete('/notifications/category/:type', (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/notifications/${userId}/category/${req.params.type}`, { method: 'DELETE' });
});

router.post('/notifications/push-tokens', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/push-tokens'));
router.delete('/notifications/push-tokens/:token', (req, res) =>
  forwardRequest(req, res, SERVICES.NOTIFICATION, `/push-tokens/${req.params.token}`));

// OTP
router.post('/otp/request', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/otp/request'));
router.post('/otp/resend', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/otp/resend'));
router.post('/otp/verify', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/otp/verify'));

// ============= HEALTH PROXY ROUTES =============
// These routes allow checking the health of internal services via the gateway

router.get('/health/gateway', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
  });
});

router.get('/health/ws-gateway', (req, res) => forwardRequest(req, res, SERVICES.WS_GATEWAY, '/healthz'));
router.get('/health/identity', (req, res) => forwardRequest(req, res, SERVICES.IDENTITY, '/healthz'));
router.get('/health/messaging', (req, res) => forwardRequest(req, res, SERVICES.MESSAGING, '/healthz'));
router.get('/health/file', (req, res) => forwardRequest(req, res, SERVICES.FILE, '/healthz'));
router.get('/health/notification', (req, res) => forwardRequest(req, res, SERVICES.NOTIFICATION, '/healthz'));
router.get('/health/ai', (req, res) => forwardRequest(req, res, SERVICES.SPRING_AI, '/healthz'));

export const proxyRoutes = router;

