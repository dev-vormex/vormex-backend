import { pushNotificationService } from "../push-notification.service";
import { NotificationService } from "./service.service";

export async function notifyHackathonTeamMatchOperation(this: NotificationService, userId: string, actorId: string, params: {
      ownerName: string;
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      skills?: string[];
    }): Promise<void> {
    const skillText = params.skills?.length
      ? ` for ${params.skills.slice(0, 2).join(', ')}`
      : '';

    const title = 'Team looking for your skills';
    const body = `${params.ownerName} is forming a ${params.hackathonTitle} team${skillText}`;

    const notificationCreated = await this.createNotification({
      userId,
      type: 'hackathon_team_match',
      title,
      body,
      actorId,
      data: {
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        skills: params.skills || [],
      },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_team_match',
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        actorId,
      },
    }).catch(() => undefined);
  }

export async function notifyNewHackathonMatchOperation(this: NotificationService, userId: string, params: {
      hackathonId: string;
      hackathonTitle: string;
      source?: string | null;
      skills?: string[];
      startsAt?: Date | string | null;
      deadline?: Date | string | null;
      actorId?: string | null;
    }): Promise<void> {
    const skillText = params.skills?.length
      ? ` Matches ${params.skills.slice(0, 2).join(', ')}.`
      : '';
    const sourceText = params.source ? `${params.source} ` : '';
    const title = 'New hackathon for you';
    const body = `${sourceText}${params.hackathonTitle} just opened.${skillText}`.slice(0, 220);

    const notificationCreated = await this.createNotification({
      userId,
      type: 'hackathon_new_match',
      title,
      body,
      actorId: params.actorId || undefined,
      data: {
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        source: params.source || null,
        skills: params.skills || [],
        startsAt: params.startsAt instanceof Date ? params.startsAt.toISOString() : params.startsAt || null,
        deadline: params.deadline instanceof Date ? params.deadline.toISOString() : params.deadline || null,
      },
    });

    if (params.actorId && !notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_new_match',
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        source: params.source || '',
        actorId: params.actorId || '',
      },
    }).catch(() => undefined);
  }

export async function notifyHackathonTeamApplicationOperation(this: NotificationService, userId: string, actorId: string, params: {
      applicantName: string;
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      applicationId: string;
    }): Promise<void> {
    const title = 'New teammate application';
    const body = `${params.applicantName} applied to join your ${params.hackathonTitle} team`;

    const notificationCreated = await this.createNotification({
      userId,
      type: 'hackathon_team_application',
      title,
      body,
      actorId,
      data: {
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        applicationId: params.applicationId,
      },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_team_application',
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        applicationId: params.applicationId,
        actorId,
      },
    }).catch(() => undefined);
  }

export async function notifyHackathonTeamApplicationAcceptedOperation(this: NotificationService, userId: string, actorId: string, params: {
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      groupId?: string | null;
    }): Promise<void> {
    const title = 'You are on the team';
    const body = `Your ${params.hackathonTitle} team application was accepted`;

    const notificationCreated = await this.createNotification({
      userId,
      type: 'hackathon_team_application_accepted',
      title,
      body,
      actorId,
      data: {
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        groupId: params.groupId || null,
      },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_team_application_accepted',
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        groupId: params.groupId || '',
        actorId,
      },
    }).catch(() => undefined);
  }

export async function notifyHackathonWeeklyDigestOperation(this: NotificationService, userId: string, count: number, sampleTitles: string[] = []): Promise<void> {
    const body = count === 1
      ? `${sampleTitles[0] || 'A new hackathon'} was posted this week`
      : `${count} new hackathons were posted this week`;

    const title = 'New hackathons this week';

    await this.createNotification({
      userId,
      type: 'hackathon_weekly_digest',
      title,
      body,
      data: {
        screen: 'hackathons',
        count,
        sampleTitles,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_weekly_digest',
        screen: 'hackathons',
        count: String(count),
      },
    }).catch(() => undefined);
  }
