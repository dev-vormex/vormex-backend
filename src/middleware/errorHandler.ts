import { Request, Response, NextFunction } from 'express';
import { getRequestId, getRequestLogger } from '../lib/logger';

/**
 * Error interface for application errors
 */
export interface AppError extends Error {
  statusCode?: number;
  status?: string;
  isOperational?: boolean;
}

/**
 * Error handling middleware
 * Handles all errors thrown in the application
 */
export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const isMulterError = err.name === 'MulterError';
  const isUploadValidationError =
    isMulterError
    || err.message === 'Only image files are allowed'
    || err.message?.includes('Unexpected field');
  const statusCode = err.statusCode || (isUploadValidationError ? ((err as any).code === 'LIMIT_FILE_SIZE' ? 413 : 400) : 500);
  const status = err.status || (isUploadValidationError ? 'bad_request' : 'error');
  const isServerError = statusCode >= 500;
  const message = isServerError
    ? 'Internal Server Error'
    : isUploadValidationError
      ? err.message || 'Invalid file upload'
      : err.message || 'Request failed';
  const requestId = getRequestId(req);
  const log = getRequestLogger(req);

  log.error({
    event: 'http.request.failure',
    requestId,
    statusCode,
    status,
    message,
    ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });

  res.status(statusCode).json({
    status,
    message,
    requestId,
  });
};

/**
 * 404 Not Found handler
 */
export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const requestPath = req.originalUrl.split('?')[0];
  const error: AppError = new Error(`Not Found - ${requestPath}`);
  error.statusCode = 404;
  error.status = 'not_found';
  next(error);
};
