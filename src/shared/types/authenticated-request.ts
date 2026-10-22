import type { Request } from 'express';

export interface AuthenticatedRequest extends Request<Record<string, string>> {
  user?: { userId: string };
}
