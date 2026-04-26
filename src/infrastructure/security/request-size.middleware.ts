import type { Request, RequestHandler } from 'express';

type RequestSizeResolver = number | ((req: Request) => number);

export function requestSizeGuard(maxBytes: RequestSizeResolver): RequestHandler {
  return (req, res, next) => {
    const limit = typeof maxBytes === 'function' ? maxBytes(req) : maxBytes;
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > limit) {
      res.status(413).json({
        error: 'Request body is too large',
      });
      return;
    }
    next();
  };
}
