import { areUsersBlocked } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { CreateNotificationParams, notificationInclude, enqueueNotificationCreatedEvents, enqueueNotificationCacheInvalidation } from "./support.service";
import { notifyProfileViewOperation } from "./profile-views.service";
import { notifyStreakMilestoneOperation, notifyXpEarnedOperation, notifyPeopleYouKnowJoinedOperation, notifyRecommendedMatchOperation, notifyAdminAnnouncementOperation } from "./growth.service";
import { notifyConnectionRequestOperation, deleteConnectionRequestNotificationsOperation, notifyConnectionAcceptedOperation } from "./connections.service";
import { notifyIdentityVerificationApprovedOperation, notifyIdentityVerificationResubmitRequestedOperation } from "./identity.service";
import { notifyHackathonTeamMatchOperation, notifyNewHackathonMatchOperation, notifyHackathonTeamApplicationOperation, notifyHackathonTeamApplicationAcceptedOperation, notifyHackathonWeeklyDigestOperation } from "./hackathons.service";
import { notifySkillEndorsementOperation, notifySkillSwapRequestOperation, notifySkillSwapAcceptedOperation, notifySkillSwapCompletedOperation, notifyCollegeCommunityJoinedOperation } from "./skills.service";
import { notifyPostCommentOperation, notifyPostLikeOperation, notifyMentionOperation, notifyPostCollabInviteOperation, notifyFollowOperation } from "./posts.service";
import { notifyReelLikeOperation, notifyReelCommentOperation, notifyReelCommentReplyOperation, notifyReelShareOperation } from "./reels.service";
import { markAsReadOperation, markAllAsReadOperation } from "./inbox.service";

export class NotificationService {
  /**
   * Create a notification and enqueue real-time fanout/cache invalidation.
   */
  async createNotification(params: CreateNotificationParams): Promise<boolean> { return createNotificationOperation.call(this, params); }

  async notifyProfileView(
    userId: string,
    viewer: {
      id: string;
      name: string;
      sameCollege?: boolean;
    }
  ): Promise<void> { return notifyProfileViewOperation.call(this, userId, viewer); }

  /**
   * Send notification for streak milestone
   */
  async notifyStreakMilestone(userId: string, streakType: string, count: number): Promise<void> { return notifyStreakMilestoneOperation.call(this, userId, streakType, count); }

  /**
   * Send XP earned notification
   */
  async notifyXpEarned(userId: string, amount: number, reason: string): Promise<void> { return notifyXpEarnedOperation.call(this, userId, amount, reason); }

  /**
   * Send connection request notification
   */
  async notifyConnectionRequest(userId: string, requesterId: string, requesterName: string): Promise<void> { return notifyConnectionRequestOperation.call(this, userId, requesterId, requesterName); }

  async deleteConnectionRequestNotifications(userId: string, actorId: string): Promise<void> { return deleteConnectionRequestNotificationsOperation.call(this, userId, actorId); }

  /**
   * Send connection accepted notification
   */
  async notifyConnectionAccepted(userId: string, accepterId: string, accepterName: string): Promise<void> { return notifyConnectionAcceptedOperation.call(this, userId, accepterId, accepterName); }

  async notifyPeopleYouKnowJoined(
    userId: string,
    count: number,
    actorId?: string
  ): Promise<void> { return notifyPeopleYouKnowJoinedOperation.call(this, userId, count, actorId); }

  async notifyRecommendedMatch(
    userId: string,
    actorId: string,
    title: string,
    body: string,
    data: Record<string, any> = {}
  ): Promise<void> { return notifyRecommendedMatchOperation.call(this, userId, actorId, title, body, data); }

  async notifyAdminAnnouncement(
    userId: string,
    title: string,
    body: string,
    data: Record<string, any> = {}
  ): Promise<void> { return notifyAdminAnnouncementOperation.call(this, userId, title, body, data); }

  async notifyIdentityVerificationApproved(
    userId: string,
    verificationId: string,
    trustLevel: string
  ): Promise<void> { return notifyIdentityVerificationApprovedOperation.call(this, userId, verificationId, trustLevel); }

  async notifyIdentityVerificationResubmitRequested(
    userId: string,
    verificationId: string,
    reason: string
  ): Promise<void> { return notifyIdentityVerificationResubmitRequestedOperation.call(this, userId, verificationId, reason); }

  async notifyHackathonTeamMatch(
    userId: string,
    actorId: string,
    params: {
      ownerName: string;
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      skills?: string[];
    }
  ): Promise<void> { return notifyHackathonTeamMatchOperation.call(this, userId, actorId, params); }

  async notifyNewHackathonMatch(
    userId: string,
    params: {
      hackathonId: string;
      hackathonTitle: string;
      source?: string | null;
      skills?: string[];
      startsAt?: Date | string | null;
      deadline?: Date | string | null;
      actorId?: string | null;
    }
  ): Promise<void> { return notifyNewHackathonMatchOperation.call(this, userId, params); }

  async notifyHackathonTeamApplication(
    userId: string,
    actorId: string,
    params: {
      applicantName: string;
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      applicationId: string;
    }
  ): Promise<void> { return notifyHackathonTeamApplicationOperation.call(this, userId, actorId, params); }

  async notifyHackathonTeamApplicationAccepted(
    userId: string,
    actorId: string,
    params: {
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      groupId?: string | null;
    }
  ): Promise<void> { return notifyHackathonTeamApplicationAcceptedOperation.call(this, userId, actorId, params); }

  async notifyHackathonWeeklyDigest(
    userId: string,
    count: number,
    sampleTitles: string[] = []
  ): Promise<void> { return notifyHackathonWeeklyDigestOperation.call(this, userId, count, sampleTitles); }

  async notifySkillEndorsement(
    userId: string,
    actorId: string,
    params: {
      endorserName: string;
      skillName: string;
      endorsementId: string;
    }
  ): Promise<void> { return notifySkillEndorsementOperation.call(this, userId, actorId, params); }

  async notifySkillSwapRequest(
    userId: string,
    requesterId: string,
    params: {
      requesterName: string;
      requestId: string;
      skillName: string;
      mode: string;
      sessionLengthMinutes?: number;
    }
  ): Promise<void> { return notifySkillSwapRequestOperation.call(this, userId, requesterId, params); }

  async notifySkillSwapAccepted(
    userId: string,
    accepterId: string,
    params: {
      accepterName: string;
      requestId: string;
      sessionId: string;
      skillName: string;
      sessionLengthMinutes?: number;
    }
  ): Promise<void> { return notifySkillSwapAcceptedOperation.call(this, userId, accepterId, params); }

  async notifySkillSwapCompleted(
    userId: string,
    actorId: string,
    params: {
      actorName: string;
      sessionId: string;
      requestId: string;
      skillName: string;
    }
  ): Promise<void> { return notifySkillSwapCompletedOperation.call(this, userId, actorId, params); }

  async notifyCollegeCommunityJoined(
    userId: string,
    actorId: string,
    params: {
      memberName: string;
      college: string;
      communityId: string;
      groupId: string;
    }
  ): Promise<void> { return notifyCollegeCommunityJoinedOperation.call(this, userId, actorId, params); }

  /**
   * Send notification when someone comments on a post
   */
  async notifyPostComment(
    postAuthorId: string,
    commenterId: string,
    commenterName: string,
    postId: string,
    commentId: string,
    commentPreview: string
  ): Promise<void> { return notifyPostCommentOperation.call(this, postAuthorId, commenterId, commenterName, postId, commentId, commentPreview); }

  /**
   * Send notification when someone likes a post
   */
  async notifyPostLike(
    postAuthorId: string,
    likerId: string,
    likerName: string,
    postId: string
  ): Promise<void> { return notifyPostLikeOperation.call(this, postAuthorId, likerId, likerName, postId); }

  /**
   * Send notification when someone mentions a user
   */
  async notifyMention(
    mentionedUserId: string,
    mentionerId: string,
    mentionerName: string,
    context: 'post' | 'comment' | 'reel' | 'reel_comment',
    referenceId: string,
    preview: string,
    metadata: {
      commentId?: string;
      parentCommentId?: string;
    } = {}
  ): Promise<void> { return notifyMentionOperation.call(this, mentionedUserId, mentionerId, mentionerName, context, referenceId, preview, metadata); }

  async notifyPostCollabInvite(
    collaboratorUserId: string,
    inviterId: string,
    inviterName: string,
    postId: string,
    preview: string
  ): Promise<void> { return notifyPostCollabInviteOperation.call(this, collaboratorUserId, inviterId, inviterName, postId, preview); }

  /**
   * Send notification when someone follows a user
   */
  async notifyFollow(
    userId: string,
    followerId: string,
    followerName: string
  ): Promise<void> { return notifyFollowOperation.call(this, userId, followerId, followerName); }

  // ============================================
  // REEL-SPECIFIC NOTIFICATIONS
  // ============================================

  /**
   * Send notification when someone likes a reel
   */
  async notifyReelLike(
    reelAuthorId: string,
    likerId: string,
    likerName: string,
    reelId: string
  ): Promise<void> { return notifyReelLikeOperation.call(this, reelAuthorId, likerId, likerName, reelId); }

  /**
   * Send notification when someone comments on a reel
   */
  async notifyReelComment(
    reelAuthorId: string,
    commenterId: string,
    commenterName: string,
    reelId: string,
    commentId: string,
    commentPreview: string
  ): Promise<void> { return notifyReelCommentOperation.call(this, reelAuthorId, commenterId, commenterName, reelId, commentId, commentPreview); }

  /**
   * Send notification when someone replies to a reel comment
   */
  async notifyReelCommentReply(
    originalCommenterId: string,
    replierId: string,
    replierName: string,
    reelId: string,
    commentId: string,
    parentCommentId: string,
    replyPreview: string
  ): Promise<void> { return notifyReelCommentReplyOperation.call(this, originalCommenterId, replierId, replierName, reelId, commentId, parentCommentId, replyPreview); }

  /**
   * Send notification when someone shares a reel
   */
  async notifyReelShare(
    reelAuthorId: string,
    sharerId: string,
    sharerName: string,
    reelId: string
  ): Promise<void> { return notifyReelShareOperation.call(this, reelAuthorId, sharerId, sharerName, reelId); }

  // ============================================
  // BATCH OPERATIONS
  // ============================================

  /**
   * Mark notifications as read
   */
  async markAsRead(userId: string, notificationIds: string[]): Promise<void> { return markAsReadOperation.call(this, userId, notificationIds); }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<void> { return markAllAsReadOperation.call(this, userId); }
}

export const notificationService = new NotificationService();

export async function createNotificationOperation(this: NotificationService, params: CreateNotificationParams): Promise<boolean> {
    const { userId, type, title, body, actorId, postId, reelId, commentId, messageId, data } = params;

    // Don't notify yourself
    if (actorId && actorId === userId) {
      return false;
    }
    if (actorId && await areUsersBlocked(actorId, userId)) {
      return false;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const notification = await tx.notifications.create({
          data: {
            userId,
            type,
            title,
            body,
            actorId,
            postId,
            reelId,
            commentId,
            messageId,
            data: data || {},
          },
          include: notificationInclude,
        });

        await enqueueNotificationCreatedEvents(tx, notification);
        await enqueueNotificationCacheInvalidation(tx, userId, notification.id);
      });
      return true;
    } catch (error) {
      console.error('Failed to create notification:', error);
      return false;
    }
  }
