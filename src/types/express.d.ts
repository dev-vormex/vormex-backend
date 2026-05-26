import 'express';
import { Logger } from 'pino';

declare global {
  namespace Express {
    interface Request {
      appCheck?: {
        appId?: string;
        expireTimeMillis?: number;
        status: 'missing' | 'valid' | 'invalid' | 'unconfigured';
      };
      requestId?: string;
      log?: Logger;
    }
  }
}

export {};
