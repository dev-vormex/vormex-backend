import type { RequestHandler } from 'express';
import {
  containsPromptInjection,
  sanitizeInputTree,
  validatePathSegments,
} from '../utils/input-security.util';

function reject(res: Parameters<RequestHandler>[1], message: string): void {
  res.status(400).json({
    error: 'Invalid request input',
    message,
  });
}

function allowsLocalhostRedirectUri(req: Parameters<RequestHandler>[0]): boolean {
  if (req.method !== 'POST') {
    return false;
  }

  const mountedPath = req.path || '';
  const originalPath = (req.originalUrl || '').split('?')[0];
  return mountedPath === '/auth/google/code' || originalPath === '/api/auth/google/code';
}

export const validateRequestInput: RequestHandler = (req, res, next) => {
  const pathResult = validatePathSegments(req.path || req.originalUrl || '');
  if (!pathResult.ok) {
    reject(res, pathResult.error || 'Invalid path');
    return;
  }

  const queryResult = sanitizeInputTree(req.query, {
    location: 'query',
    maxDepth: 4,
    maxStringLength: 512,
  });
  if (!queryResult.ok) {
    reject(res, queryResult.error || 'Invalid query parameters');
    return;
  }
  req.query = queryResult.value as typeof req.query;

  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const bodyResult = sanitizeInputTree(req.body, {
      allowLocalhostUrls: allowsLocalhostRedirectUri(req),
      location: 'body',
      maxDepth: 8,
      maxStringLength: 8_000,
    });
    if (!bodyResult.ok) {
      reject(res, bodyResult.error || 'Invalid request body');
      return;
    }
    req.body = bodyResult.value;
  }

  next();
};

function findPromptInjection(value: unknown, path: string[] = []): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return containsPromptInjection(value) ? (path.join('.') || 'value') : null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = findPromptInjection(value[index], [...path, String(index)]);
      if (result) return result;
    }
    return null;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const result = findPromptInjection(child, [...path, key]);
      if (result) return result;
    }
  }

  return null;
}

export const validateAIRequestInput: RequestHandler = (req, res, next) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const promptPath = findPromptInjection(req.body);
    if (promptPath) {
      res.status(400).json({
        error: 'AI request contains unsafe prompt-injection instructions',
        code: 'ai_prompt_injection_blocked',
        field: promptPath,
      });
      return;
    }
  }

  next();
};

export const validateMultipartFields: RequestHandler = (req, res, next) => {
  if (!req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) {
    next();
    return;
  }

  const bodyResult = sanitizeInputTree(req.body, {
    location: 'multipart',
    maxDepth: 6,
    maxStringLength: 8_000,
  });
  if (!bodyResult.ok) {
    reject(res, bodyResult.error || 'Invalid multipart fields');
    return;
  }

  req.body = bodyResult.value;
  next();
};
