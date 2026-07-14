import { randomUUID } from 'crypto';
import { Request } from 'express';
import pino, { Logger } from 'pino';
import pinoHttp from 'pino-http';
import { AuthenticatedRequest } from '../types/auth.types';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.newPassword',
      'req.body.token',
      'req.body.refreshToken',
      'req.body.idToken',
      'req.query.token',
      'headers.authorization',
      'headers.cookie',
      'authorization',
      'cookie',
      'password',
      'newPassword',
      'token',
      'refreshToken',
      'csrfToken',
      'resetToken',
      'verificationToken',
      'adminTwoFactorSecret',
      'githubAccessToken',
      'openaiApiKey',
      'apiKey',
      'latitude',
      'longitude',
      'lat',
      'lng',
      '*.latitude',
      '*.longitude',
      '*.*.latitude',
      '*.*.longitude',
      '*.lat',
      '*.lng',
      '*.*.lat',
      '*.*.lng',
      'req.body.latitude',
      'req.body.longitude',
      'req.body.lat',
      'req.body.lng',
      'req.body.coordinates',
      'req.body.sample',
      'req.body.samples',
      'req.body.locationSample',
      'req.query.latitude',
      'req.query.longitude',
      'req.query.lat',
      'req.query.lng',
      'req.query.coordinates',
      'req.query.viewport',
      'coordinates',
      '*.coordinates',
      '*.*.coordinates',
      'sample',
      'samples',
      'locationSample',
    ],
    censor: '[REDACTED]',
  },
});

export const httpLogger = pinoHttp({
  logger,
  quietReqLogger: true,
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  genReqId(req, res) {
    const request = req as Request;
    const headerValue = req.headers['x-request-id'];
    const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue || randomUUID();
    request.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    return requestId;
  },
  serializers: {
    req(req) {
      const request = req as Request;
      const remoteAddress =
        request.ip ||
        request.socket?.remoteAddress ||
        (req as Request & { connection?: { remoteAddress?: string } }).connection?.remoteAddress ||
        null;

      return {
        requestId: request.requestId,
        method: req.method,
        url: req.url,
        remoteAddress,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
  customProps(req) {
    const authenticatedReq = req as Request & AuthenticatedRequest;
    return {
      requestId: authenticatedReq.requestId,
      userId: authenticatedReq.user?.userId ? String(authenticatedReq.user.userId) : null,
      ip: authenticatedReq.ip,
    };
  },
});

export function getRequestId(req: Request): string {
  return req.requestId || 'unknown-request';
}

export function getRequestLogger(req: Request): Logger {
  return req.log || logger;
}
