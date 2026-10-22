import { isAllowedRequestOrigin } from '../config/http.config';
import express, { Express, Request, Response } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { httpLogger } from '../infrastructure/logging/logger';
import { metricsMiddleware } from '../shared/middleware/metrics.middleware';
import { handleRazorpayWebhook } from '../modules/premium/controllers/premium.controller';
import { requestSizeGuard } from '../infrastructure/security/request-size.middleware';
import { validateRequestInput } from '../shared/middleware/input-validation.middleware';
import { mcpCorsHeaders } from './mcp/public-discovery.mcp';

export function configureHttpMiddleware(app: Express): void {
  const DEFAULT_REQUEST_MAX_BYTES = 5 * 1024 * 1024;
  const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
  const STORY_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
  const POST_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
  const CHAT_UPLOAD_MAX_BYTES = 150 * 1024 * 1024;

  const getRequestMaxBytes = (req: Request): number => {
    if (req.method !== 'POST') {
      return DEFAULT_REQUEST_MAX_BYTES;
    }

    const path = req.path.replace(/\/$/, '');
    if (path === '/api/posts') {
      return POST_UPLOAD_MAX_BYTES;
    }
    if (path === '/api/reels' || path === '/api/chat/upload' || path === '/api/upload/chat') {
      return CHAT_UPLOAD_MAX_BYTES;
    }
    if (path === '/api/stories') {
      return STORY_UPLOAD_MAX_BYTES;
    }
    if (
      path === '/api/upload/avatar' ||
      path === '/api/upload/banner' ||
      path === '/api/upload/certificate' ||
      path === '/api/upload/project' ||
      path === '/api/upload/logo' ||
      path === '/api/upload/group-icon' ||
      path === '/api/upload/group-cover' ||
      /^\/api\/groups\/[^/]+\/upload\/(icon|cover)$/.test(path) ||
      path === '/api/users/me/avatar' ||
      path === '/api/users/me/banner'
    ) {
      return IMAGE_UPLOAD_MAX_BYTES;
    }
    if (/^\/api\/agent\/sessions\/[^/]+\/voice$/.test(path)) {
      return 20 * 1024 * 1024;
    }
    return DEFAULT_REQUEST_MAX_BYTES;
  };

  app.use('/mcp', mcpCorsHeaders);
  app.use(httpLogger);
  app.use(metricsMiddleware);
  app.use(helmet());
  app.use(requestSizeGuard(getRequestMaxBytes));
  app.use(compression());
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, isAllowedRequestOrigin(origin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-CSRF-Token',
        'X-Auth-Token-Transport',
        'X-Firebase-AppCheck',
        'X-Vormex-Client',
        'X-Vormex-Install-Id',
        'X-Vormex-Platform',
        'X-Vormex-App-Version',
        'X-Vormex-App-Build',
      ],
    })
  );

  app.use(
    '/api/proximity/v1',
    express.json({
      limit: '16kb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use('/api/proximity/v1', (error: any, _req: Request, res: Response, next: (error?: any) => void) => {
    if (error?.type === 'entity.too.large') {
      res
        .status(413)
        .json({ error: { code: 'PROXIMITY_INVALID_REQUEST', message: 'Request is too large', retryable: false } });
      return;
    }
    if (error instanceof SyntaxError) {
      res
        .status(400)
        .json({
          error: { code: 'PROXIMITY_INVALID_REQUEST', message: 'Request body must be valid JSON', retryable: false },
        });
      return;
    }
    next(error);
  });
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // Razorpay retries a webhook until it gets a 2xx, so it is mounted ahead of the shared
  // /api input sanitizer and the premium router's `authenticate`: a signed provider payload
  // must never be rejected by rules written for user-submitted content or missing sessions.
  // The handler authenticates the request by HMAC over the raw body instead.
  app.post('/api/premium/razorpay/webhook', handleRazorpayWebhook);

  /*
   * Default: authenticated API responses are never written to disk anywhere.
   *
   * `API_RESPONSE_REVALIDATION=true` switches safe reads to `private, no-cache`
   * instead. Express already emits a body-derived ETag, so the browser can then
   * revalidate and take a 304 with an empty body rather than re-downloading an
   * unchanged feed page. It does NOT save the server any database work — only
   * transfer — and it does allow private responses into the browser's on-disk
   * cache, which is a real exposure on a shared machine. That is why it is opt-in
   * rather than the default; turn it on only if the devices are trusted.
   *
   * Unsafe methods and every non-GET path keep `no-store` regardless.
   */
  const apiResponseRevalidationEnabled = process.env.API_RESPONSE_REVALIDATION === 'true';

  app.use('/api', (req: Request, res: Response, next) => {
    const revalidatable = apiResponseRevalidationEnabled && (req.method === 'GET' || req.method === 'HEAD');

    if (revalidatable) {
      res.setHeader('Cache-Control', 'private, no-cache');
    } else {
      res.setHeader('Cache-Control', 'no-store, private');
      // Only meaningful to HTTP/1.0 intermediaries, and it defeats revalidation.
      res.setHeader('Pragma', 'no-cache');
    }
    res.setHeader('Vary', 'Accept-Encoding, Authorization, Cookie');
    next();
  });
  app.use('/api', validateRequestInput);
}
