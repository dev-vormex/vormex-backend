import type { RequestHandler } from 'express';

export function requestSizeGuard(maxBytes: number): RequestHandler {
  return (req, res, next) => {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > maxBytes) {
      res.status(413).json({
        error: 'Request body is too large',
      });
      return;
    }
    next();
  };
}
