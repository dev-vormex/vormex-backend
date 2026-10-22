import { pushNotificationService } from "../push-notification.service";
import { NotificationService } from "./service.service";
import { NotificationType } from "./support.service";

export async function notifyPostCommentOperation(this: NotificationService, postAuthorId: string, commenterId: string, commenterName: string, postId: string, commentId: string, commentPreview: string): Promise<void> {
    const notificationCreated = await this.createNotification({
      userId: postAuthorId,
      type: 'comment',
      title: '💬 New Comment',
      body: `${commenterName} commented: "${commentPreview.slice(0, 50)}${commentPreview.length > 50 ? '...' : ''}"`,
      actorId: commenterId,
      postId,
      commentId,
      data: { commentPreview },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(postAuthorId, {
      title: 'New Comment',
      body: `${commenterName} commented: "${commentPreview.slice(0, 50)}${commentPreview.length > 50 ? '...' : ''}"`,
      data: {
        type: 'comment',
        screen: 'post',
        actorId: commenterId,
        postId,
        commentId,
      },
    }).catch(() => undefined);
  }

export async function notifyPostLikeOperation(this: NotificationService, postAuthorId: string, likerId: string, likerName: string, postId: string): Promise<void> {
    const notificationCreated = await this.createNotification({
      userId: postAuthorId,
      type: 'like',
      title: '❤️ New Like',
      body: `${likerName} liked your post`,
      actorId: likerId,
      postId,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(postAuthorId, {
      title: 'New Like',
      body: `${likerName} liked your post`,
      data: {
        type: 'like',
        screen: 'post',
        actorId: likerId,
        postId,
      },
    }).catch(() => undefined);
  }

export async function notifyMentionOperation(this: NotificationService, mentionedUserId: string, mentionerId: string, mentionerName: string, context: 'post' | 'comment' | 'reel' | 'reel_comment', referenceId: string, preview: string, metadata: {
      commentId?: string;
      parentCommentId?: string;
    } = {}): Promise<void> {
    const typeMap = {
      post: 'mention' as NotificationType,
      comment: 'mention' as NotificationType,
      reel: 'reel_mention' as NotificationType,
      reel_comment: 'reel_mention' as NotificationType,
    };
    const type = typeMap[context];
    const isReelContext = context === 'reel' || context === 'reel_comment';
    const title = '📢 You were mentioned';
    const body = `${mentionerName} mentioned you: "${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}"`;
    const data = {
      type,
      screen: isReelContext ? 'reel' : 'post',
      context,
      preview,
      actorId: mentionerId,
      ...(isReelContext ? { reelId: referenceId } : { postId: referenceId }),
      ...(metadata.commentId ? { commentId: metadata.commentId } : {}),
      ...(metadata.parentCommentId ? { parentCommentId: metadata.parentCommentId } : {}),
    };

    const notificationCreated = await this.createNotification({
      userId: mentionedUserId,
      type,
      title,
      body,
      actorId: mentionerId,
      postId: context === 'post' || context === 'comment' ? referenceId : undefined,
      reelId: context === 'reel' || context === 'reel_comment' ? referenceId : undefined,
      commentId: metadata.commentId,
      data,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(mentionedUserId, {
      title,
      body,
      data: Object.fromEntries(
        Object.entries(data)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
      ),
    }).catch(() => undefined);
  }

export async function notifyPostCollabInviteOperation(this: NotificationService, collaboratorUserId: string, inviterId: string, inviterName: string, postId: string, preview: string): Promise<void> {
    const title = '🤝 Collab invite';
    const body = `${inviterName} invited you to collaborate on a post`;
    const data = {
      type: 'mention',
      screen: 'post',
      context: 'post_collab_invite',
      collabStatus: 'pending',
      preview,
      actorId: inviterId,
      postId,
    };

    const notificationCreated = await this.createNotification({
      userId: collaboratorUserId,
      type: 'mention',
      title,
      body,
      actorId: inviterId,
      postId,
      data,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(collaboratorUserId, {
      title,
      body,
      data: Object.fromEntries(
        Object.entries(data)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
      ),
    }).catch(() => undefined);
  }

export async function notifyFollowOperation(this: NotificationService, userId: string, followerId: string, followerName: string): Promise<void> {
    await this.createNotification({
      userId,
      type: 'follow',
      title: 'New Follower',
      body: `${followerName} started following you`,
      actorId: followerId,
    });
  }
