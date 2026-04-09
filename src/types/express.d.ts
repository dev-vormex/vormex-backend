import 'express';
import { Logger } from 'pino';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      log?: Logger;
    }
  }
}

export {};
