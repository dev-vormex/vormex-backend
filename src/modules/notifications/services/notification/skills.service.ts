import { pushNotificationService } from "../push-notification.service";
import { NotificationService } from "./service.service";

export async function notifySkillEndorsementOperation(this: NotificationService, userId: string, actorId: string, params: {
      endorserName: string;
      skillName: string;
      endorsementId: string;
    }): Promise<void> {
    const title = 'New skill endorsement';
    const body = `${params.endorserName} endorsed you for ${params.skillName}`;

    const notificationCreated = await this.createNotification({
      userId,
      type: 'skill_endorsement',
      title,
      body,
      actorId,
      data: {
        screen: 'skill_passport',
        skillName: params.skillName,
        endorsementId: params.endorsementId,
      },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'skill_endorsement',
        screen: 'skill_passport',
        skillName: params.skillName,
        endorsementId: params.endorsementId,
        actorId,
      },
    }).catch(() => undefined);
  }

export async function notifySkillSwapRequestOperation(this: NotificationService, userId: string, requesterId: string, params: {
      requesterName: string;
      requestId: string;
      skillName: string;
      mode: string;
      sessionLengthMinutes?: number;
    }): Promise<void> {
    const title = 'Skill Swap request';
    const body = params.mode === 'teach'
      ? `${params.requesterName} offered to help you with ${params.skillName}`
      : `${params.requesterName} asked to learn ${params.skillName} from you`;
    const data = {
      screen: 'skill_swap',
      tab: 'requests',
      requestId: params.requestId,
      skillName: params.skillName,
      mode: params.mode,
      sessionLengthMinutes: String(params.sessionLengthMinutes || ''),
    };

    const notificationCreated = await this.createNotification({
      userId,
      type: 'skill_swap_request',
      title,
      body,
      actorId: requesterId,
      data,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'skill_swap_request',
        actorId: requesterId,
        ...data,
      },
    }).catch(() => undefined);
  }

export async function notifySkillSwapAcceptedOperation(this: NotificationService, userId: string, accepterId: string, params: {
      accepterName: string;
      requestId: string;
      sessionId: string;
      skillName: string;
      sessionLengthMinutes?: number;
    }): Promise<void> {
    const title = 'Skill Swap accepted';
    const body = `${params.accepterName} accepted your ${params.skillName} swap`;
    const data = {
      screen: 'skill_swap',
      tab: 'sessions',
      requestId: params.requestId,
      sessionId: params.sessionId,
      skillName: params.skillName,
      sessionLengthMinutes: String(params.sessionLengthMinutes || ''),
    };

    const notificationCreated = await this.createNotification({
      userId,
      type: 'skill_swap_accepted',
      title,
      body,
      actorId: accepterId,
      data,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'skill_swap_accepted',
        actorId: accepterId,
        ...data,
      },
    }).catch(() => undefined);
  }

export async function notifySkillSwapCompletedOperation(this: NotificationService, userId: string, actorId: string, params: {
      actorName: string;
      sessionId: string;
      requestId: string;
      skillName: string;
    }): Promise<void> {
    const title = 'Skill Swap completed';
    const body = `${params.actorName} completed your ${params.skillName} session`;
    const data = {
      screen: 'skill_swap',
      tab: 'sessions',
      requestId: params.requestId,
      sessionId: params.sessionId,
      skillName: params.skillName,
    };

    const notificationCreated = await this.createNotification({
      userId,
      type: 'skill_swap_completed',
      title,
      body,
      actorId,
      data,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'skill_swap_completed',
        actorId,
        ...data,
      },
    }).catch(() => undefined);
  }

export async function notifyCollegeCommunityJoinedOperation(this: NotificationService, userId: string, actorId: string, params: {
      memberName: string;
      college: string;
      communityId: string;
      groupId: string;
    }): Promise<void> {
    const title = 'College community grew';
    const body = `${params.memberName} joined ${params.college}`;

    const notificationCreated = await this.createNotification({
      userId,
      type: 'college_community_joined',
      title,
      body,
      actorId,
      data: {
        screen: 'college_communities',
        communityId: params.communityId,
        groupId: params.groupId,
      },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'college_community_joined',
        screen: 'college_communities',
        communityId: params.communityId,
        groupId: params.groupId,
        actorId,
      },
    }).catch(() => undefined);
  }
