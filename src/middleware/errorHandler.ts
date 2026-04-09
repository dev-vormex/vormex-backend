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
  const statusCode = err.statusCode || 500;
  const status = err.status || 'error';
  const message = err.message || 'Internal Server Error';
  const requestId = getRequestId(req);
  const log = getRequestLogger(req);

  log.error({
    event: 'http.request.failure',
    requestId,
    statusCode,
    status,
    message,
    stack: err.stack,
  });

  res.status(statusCode).json({
    status,
    message,
    requestId,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
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
  const error: AppError = new Error(`Not Found - ${req.originalUrl}`);
  error.statusCode = 404;
  error.status = 'not_found';
  next(error);
};
