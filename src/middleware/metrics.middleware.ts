import type { NextFunction, Request, Response } from 'express';
import { httpRequestDuration } from '../infrastructure/metrics/registry';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    httpRequestDuration.observe(
      {
        method: req.method,
        route: req.route?.path || req.path || 'unknown',
        status_code: String(res.statusCode),
      },
      durationMs
    );
  });

  next();
}
