import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../../../shared/types/authenticated-request';
import { listGroupPosts, createGroupPostRecord } from '../../services/group-posts.service';

export const getGroupPosts = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(req.query.page), 10) || 1));
  const limit = Math.max(1, Math.min(50, Number.parseInt(String(req.query.limit), 10) || 20));
  try {
    res.json(await listGroupPosts(req.params.groupId, req.user?.userId ?? null, page, limit));
  } catch (error) {
    next(error);
  }
};

export const createGroupPost = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!req.user?.userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    res.status(201).json(await createGroupPostRecord(req.params.groupId, req.user.userId, req.body ?? {}));
  } catch (error) {
    next(error);
  }
};
