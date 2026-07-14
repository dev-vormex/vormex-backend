import { Router } from 'express';
import { createHash } from 'crypto';
import { authenticate } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import * as controller from '../controllers/proximity.controller';

const router = Router();
const hashedDeviceIdentifier = (value: unknown): string => createHash('sha256')
  .update(String(value || 'unknown'))
  .digest('hex')
  .slice(0, 32);
router.use(authenticate);
router.use((req, res, next) => {
  const length = Number(req.headers['content-length'] || 0);
  const parsedLength = Buffer.isBuffer((req as any).rawBody) ? (req as any).rawBody.length : 0;
  if (length > 16 * 1024 || parsedLength > 16 * 1024) { res.status(413).json({ error: { code: 'PROXIMITY_INVALID_REQUEST', message: 'Request is too large', retryable: false } }); return; }
  next();
});
const readLimit = createRateLimitMiddleware(() => [
  { keyPrefix: 'proximity:read:user', limit: 180, windowSeconds: 60, code: 'PROXIMITY_RATE_LIMITED' },
  { keyPrefix: 'proximity:read:ip', limit: 360, windowSeconds: 60, code: 'PROXIMITY_RATE_LIMITED' },
]);
const writeLimit = createRateLimitMiddleware((req) => [
  { keyPrefix: 'proximity:write:user', limit: 90, windowSeconds: 60, code: 'PROXIMITY_RATE_LIMITED' },
  { keyPrefix: 'proximity:write:ip', limit: 180, windowSeconds: 60, code: 'PROXIMITY_RATE_LIMITED' },
  { keyPrefix: 'proximity:write:device', limit: 120, windowSeconds: 60, code: 'PROXIMITY_RATE_LIMITED',
    identifier: () => hashedDeviceIdentifier(req.headers['x-vormex-install-id'] || req.ip) },
]);
const heartbeatLimit = createRateLimitMiddleware((req) => [
  { keyPrefix: 'proximity:heartbeat:session', limit: 12, windowSeconds: 60, code: 'PROXIMITY_RATE_LIMITED', identifier: () => String(req.params.sessionId) },
]);

router.get('/capabilities', readLimit, controller.getCapabilities);
router.get('/settings', readLimit, controller.getSettings);
router.put('/settings', writeLimit, controller.updateSettings);
router.post('/sessions', writeLimit, controller.createSession);
router.get('/sessions/current', readLimit, controller.currentSession);
router.post('/sessions/:sessionId/resume', writeLimit, controller.resumeSession);
router.post('/sessions/:sessionId/heartbeat', writeLimit, heartbeatLimit, controller.heartbeat);
router.post('/sessions/:sessionId/stop', writeLimit, controller.stopSession);
router.post('/presence', writeLimit, controller.publicPresence);
router.get('/live', readLimit, controller.live);
router.get('/history', readLimit, controller.history);
router.delete('/history', writeLimit, controller.removeAllHistory);
router.delete('/history/:targetUserId', writeLimit, controller.removeHistory);
router.put('/history/:targetUserId/hidden', writeLimit, controller.hideHistory);
router.get('/summaries/pending', readLimit, controller.pendingSummaries);
router.post('/summaries/:sessionId/viewed', writeLimit, controller.summaryViewed);
export default router;
