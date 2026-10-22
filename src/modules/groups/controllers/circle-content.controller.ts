import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../../shared/types/authenticated-request';
import {
  discoverCircles,
  getMyCircles,
  getCircleDetail,
  getCircleMembers,
  getCirclePosts,
} from '../services/circles/read.service';
import { createCircle, joinCircle, leaveCircle, createCirclePost } from '../services/circles/write.service';

function endpoint(operation: (req: AuthenticatedRequest, userId: string) => Promise<unknown>, status = 200) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    void operation(req, req.user.userId)
      .then((body) => {
        res.status(status).json(body);
      })
      .catch(next);
  };
}

export const discover = endpoint((req, userId) => discoverCircles(userId, req.query));
export const mine = endpoint((_req, userId) => getMyCircles(userId));
export const detail = endpoint((req, userId) => getCircleDetail(userId, req.params.slug));
export const members = endpoint((req, userId) => getCircleMembers(userId, req.params.circleId, req.query.page));
export const posts = endpoint((req, userId) => getCirclePosts(userId, req.params.circleId, req.query.page));
export const create = endpoint((req, userId) => createCircle(userId, req.body ?? {}), 201);
export const join = endpoint((req, userId) => joinCircle(userId, req.params.circleId));
export const leave = endpoint((req, userId) => leaveCircle(userId, req.params.circleId));
export const createPost = endpoint((req, userId) => createCirclePost(userId, req.params.circleId, req.body ?? {}), 201);
