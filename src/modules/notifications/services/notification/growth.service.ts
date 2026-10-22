import { NotificationService } from "./service.service";

export async function notifyStreakMilestoneOperation(this: NotificationService, userId: string, streakType: string, count: number): Promise<void> {
    await this.createNotification({
      userId,
      type: 'streak_milestone',
      title: '🔥 Streak Milestone!',
      body: `Amazing! You've reached a ${count}-day ${streakType} streak!`,
      data: { streakType, count },
    });
  }

export async function notifyXpEarnedOperation(this: NotificationService, userId: string, amount: number, reason: string): Promise<void> {
    await this.createNotification({
      userId,
      type: 'xp_earned',
      title: '⭐ XP Earned!',
      body: `+${amount} XP for ${reason}`,
      data: { amount, reason },
    });
  }

export async function notifyPeopleYouKnowJoinedOperation(this: NotificationService, userId: string, count: number, actorId?: string): Promise<void> {
    const body =
      count > 1 ? `${count} contacts just joined Vormex` : 'A contact just joined Vormex';

    await this.createNotification({
      userId,
      type: 'people_you_know_joined',
      title: 'People You Know',
      body,
      actorId,
      data: {
        count,
        screen: 'find_people',
        tab: 'people_you_know',
      },
    });
  }

export async function notifyRecommendedMatchOperation(this: NotificationService, userId: string, actorId: string, title: string, body: string, data: Record<string, any> = {}): Promise<void> {
    await this.createNotification({
      userId,
      type: 'recommended_match',
      title,
      body,
      actorId,
      data: {
        screen: 'find_people',
        tab: 'smart_matches',
        ...data,
      },
    });
  }

export async function notifyAdminAnnouncementOperation(this: NotificationService, userId: string, title: string, body: string, data: Record<string, any> = {}): Promise<void> {
    await this.createNotification({
      userId,
      type: 'admin_announcement',
      title,
      body,
      data: {
        senderType: 'admin',
        branding: 'vormex',
        source: 'admin_panel',
        ...data,
      },
    });
  }
