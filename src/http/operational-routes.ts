import { Express, Request, Response } from 'express';
import { prisma, collectDbConnectionMetrics } from '../config/prisma';
import { logger } from '../infrastructure/logging/logger';
import { requireMetricsIpAllowList } from '../shared/middleware/metrics.middleware';
import { requireAdmin } from '../shared/middleware/admin.middleware';
import { setupSwagger } from './swagger';
import { register } from '../infrastructure/metrics/registry';
import { getRedisHealth } from '../infrastructure/redis/client';
import { getBackgroundProcessesHealth } from '../infrastructure/health/background-process-heartbeat';
import { authenticate } from '../shared/middleware/auth.middleware';

export function registerOperationalRoutes(app: Express, PORT: string | number): void {
  /**
   * Health check endpoint
   * Tests database connection and returns server status
   */
  app.get('/api/health/live', async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({
      status: 'ok',
      timestamp: Date.now(),
    });
  });

  app.get('/api/health/ready', async (_req: Request, res: Response): Promise<void> => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const [redisHealth, backgroundProcesses] = await Promise.all([getRedisHealth(), getBackgroundProcessesHealth()]);
      const redisReady = Object.values(redisHealth.roles).every(
        (role) => role.status === 'connected' || role.status === 'disabled'
      );
      const ready = redisReady && backgroundProcesses.healthy;

      res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : 'error',
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error({ event: 'health.readiness_failed', error });
      res.status(503).json({
        status: 'error',
        timestamp: Date.now(),
      });
    }
  });

  app.get('/api/health', async (_req: Request, res: Response): Promise<void> => {
    try {
      // Test Prisma connection
      await prisma.$queryRaw`SELECT 1`;

      res.status(200).json({
        status: 'ok',
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error({ event: 'health.database_failed', error });
      res.status(503).json({
        status: 'error',
        timestamp: Date.now(),
      });
    }
  });

  app.get(
    '/metrics',
    requireMetricsIpAllowList,
    authenticate,
    requireAdmin,
    async (_req: Request, res: Response): Promise<void> => {
      await collectDbConnectionMetrics();
      res.setHeader('Content-Type', register.contentType);
      res.status(200).send(await register.metrics());
    }
  );

  // API documentation is disabled by default in production to avoid exposing the
  // complete attack surface. Enable it deliberately for a protected environment.
  if (process.env.NODE_ENV !== 'production' || process.env.API_DOCS_ENABLED === 'true') {
    setupSwagger(app, PORT);
  }
}
