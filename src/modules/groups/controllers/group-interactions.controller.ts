import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../../shared/types/authenticated-request';
import {
  listGroupInvites,
  cancelGroupInvite,
  reactToGroupMessage,
  deleteGroupMessageRecord,
} from '../services/group-interactions.service';
import { toggleGroupPostReaction, pinGroupPostRecord, deleteGroupPostRecord } from '../services/group-posts.service';

function endpoint(operation: (req: AuthenticatedRequest, userId: string) => Promise<unknown>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    void operation(req, req.user.userId)
      .then((body) => {
        res.json(body);
      })
      .catch(next);
  };
}
export const invites = endpoint((req, userId) =>
  listGroupInvites(req.params.groupId, userId, String(req.query.status ?? 'pending'))
);
export const cancelInvite = endpoint((req, userId) =>
  cancelGroupInvite(req.params.groupId, req.params.inviteId, userId)
);
export const likePost = endpoint((req, userId) =>
  toggleGroupPostReaction(req.params.groupId, req.params.postId, userId)
);
export const pinPost = endpoint((req, userId) =>
  pinGroupPostRecord(req.params.groupId, req.params.postId, userId, req.body?.isPinned)
);
export const deletePost = endpoint((req, userId) =>
  deleteGroupPostRecord(req.params.groupId, req.params.postId, userId)
);
export const react = endpoint((req, userId) =>
  reactToGroupMessage(req.params.groupId, req.params.messageId, userId, req.body?.emoji)
);
export const deleteMessage = endpoint((req, userId) =>
  deleteGroupMessageRecord(req.params.groupId, req.params.messageId, userId)
);
