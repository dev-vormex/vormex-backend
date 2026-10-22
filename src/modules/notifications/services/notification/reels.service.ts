import { pushNotificationService } from "../push-notification.service";
import { NotificationService } from "./service.service";

export async function notifyReelLikeOperation(this: NotificationService, reelAuthorId: string, likerId: string, likerName: string, reelId: string): Promise<void> {
    const notificationCreated = await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_like',
      title: '❤️ New Like on Reel',
      body: `${likerName} liked your reel`,
      actorId: likerId,
      reelId,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(reelAuthorId, {
      title: 'New Like on Reel',
      body: `${likerName} liked your reel`,
      data: {
        type: 'reel_like',
        screen: 'reel',
        actorId: likerId,
        reelId,
      },
    }).catch(() => undefined);
  }

export async function notifyReelCommentOperation(this: NotificationService, reelAuthorId: string, commenterId: string, commenterName: string, reelId: string, commentId: string, commentPreview: string): Promise<void> {
    const preview = String(commentPreview || '').trim() || 'your reel';
    const title = '💬 New Comment on Reel';
    const body = `${commenterName} commented: "${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}"`;
    const data = {
      type: 'reel_comment',
      screen: 'reel',
      reelId,
      commentId,
      actorId: commenterId,
      commentPreview: preview,
    };

    const notificationCreated = await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_comment',
      title,
      body,
      actorId: commenterId,
      reelId,
      commentId,
      data,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(reelAuthorId, {
      title,
      body,
      data,
    }).catch(() => undefined);
  }

export async function notifyReelCommentReplyOperation(this: NotificationService, originalCommenterId: string, replierId: string, replierName: string, reelId: string, commentId: string, parentCommentId: string, replyPreview: string): Promise<void> {
    const preview = String(replyPreview || '').trim() || 'your comment';
    const title = '↩️ New Reply on Reel';
    const body = `${replierName} replied: "${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}"`;
    const data = {
      type: 'reel_comment_reply',
      screen: 'reel',
      reelId,
      commentId,
      parentCommentId,
      actorId: replierId,
      replyPreview: preview,
    };

    const notificationCreated = await this.createNotification({
      userId: originalCommenterId,
      type: 'reel_comment_reply',
      title,
      body,
      actorId: replierId,
      reelId,
      commentId,
      data,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(originalCommenterId, {
      title,
      body,
      data,
    }).catch(() => undefined);
  }

export async function notifyReelShareOperation(this: NotificationService, reelAuthorId: string, sharerId: string, sharerName: string, reelId: string): Promise<void> {
    const notificationCreated = await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_share',
      title: '🔗 Reel Shared',
      body: `${sharerName} shared your reel`,
      actorId: sharerId,
      reelId,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(reelAuthorId, {
      title: 'Reel Shared',
      body: `${sharerName} shared your reel`,
      data: {
        type: 'reel_share',
        screen: 'reel',
        actorId: sharerId,
        reelId,
      },
    }).catch(() => undefined);
  }
