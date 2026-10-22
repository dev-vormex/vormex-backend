import { areUsersBlocked } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { pushNotificationService } from "../push-notification.service";
import { asString, asBoolean, asDate, notificationInclude, PROFILE_VIEW_WINDOW_MS, PROFILE_VIEW_BATCH_LIMIT, enqueueNotificationCacheInvalidation, enqueueNotificationCreatedEvents } from "./support.service";
import { NotificationService } from "./service.service";

export const asProfileViewers = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();

  return value.reduce<Array<{ id: string; name: string; sameCollege: boolean }>>((accumulator, item) => {
    const id = asString(item?.id);
    const name = asString(item?.name);
    const sameCollege = asBoolean(item?.sameCollege) ?? false;

    if (!id || !name || seen.has(id)) {
      return accumulator;
    }

    seen.add(id);
    accumulator.push({ id, name, sameCollege });
    return accumulator;
  }, []);
};

export const normalizeProfileViewViewerName = (name?: string | null) => {
  const trimmed = asString(name);
  return trimmed || 'Someone';
};

export const parseProfileViewNotificationData = (notification: any) => {
  const data = notification?.data && typeof notification.data === 'object'
    ? notification.data
    : {};
  const viewers = asProfileViewers(data.viewers);
  const fallbackActorId = asString(notification?.actorId);
  const fallbackActorName =
    normalizeProfileViewViewerName(
      notification?.users_notifications_actorIdTousers?.name ||
      notification?.users_notifications_actorIdTousers?.username
    );
  const fallbackSameCollege = asBoolean(data.sameCollegeHint) ?? false;
  const normalizedViewers = viewers.length > 0
    ? viewers
    : fallbackActorId
      ? [{ id: fallbackActorId, name: fallbackActorName, sameCollege: fallbackSameCollege }]
      : [];

  const windowStartedAt =
    asDate(data.windowStartedAt) ||
    notification?.createdAt ||
    new Date();
  const batchKey =
    asString(data.batchKey) ||
    asString(data.notificationBatchKey) ||
    (notification?.id ? `profile_view:${notification.id}` : null) ||
    `profile_view:${windowStartedAt.getTime()}`;

  return {
    batchKey,
    windowStartedAt,
    viewers: normalizedViewers,
  };
};

export const buildProfileViewNotificationCopy = (
  viewers: Array<{ id: string; name: string; sameCollege: boolean }>
) => {
  const viewerCount = viewers.length;
  const sameCollegeCount = viewers.filter((viewer) => viewer.sameCollege).length;

  if (viewerCount <= 1) {
    if (sameCollegeCount > 0) {
      return {
        title: 'Campus profile view',
        body: 'Someone from your college viewed your profile',
      };
    }

    return {
      title: 'Profile view',
      body: 'Someone viewed your profile',
    };
  }

  if (sameCollegeCount === viewerCount) {
    return {
      title: 'Campus profile views',
      body: `${viewerCount} people from your college viewed your profile`,
    };
  }

  if (sameCollegeCount > 0) {
    const othersCount = viewerCount - 1;
    return {
      title: 'Profile views',
      body: othersCount > 1
        ? `Someone from your college and ${othersCount} others viewed your profile`
        : 'Someone from your college and someone else viewed your profile',
    };
  }

  return {
    title: 'Profile views',
    body: `${viewerCount} people viewed your profile`,
  };
};

export async function notifyProfileViewOperation(this: NotificationService, userId: string, viewer: {
      id: string;
      name: string;
      sameCollege?: boolean;
    }): Promise<void> {
    const viewerId = viewer?.id;
    if (!userId || !viewerId || userId === viewerId) {
      return;
    }
    if (await areUsersBlocked(viewerId, userId)) {
      return;
    }

    const now = new Date();
    const normalizedViewerName = normalizeProfileViewViewerName(viewer.name);
    const sameCollege = !!viewer.sameCollege;

    try {
      const delivery = await prisma.$transaction(async (tx) => {
        const recentNotifications = await tx.notifications.findMany({
          where: {
            userId,
            type: 'profile_view',
          },
          include: notificationInclude,
          orderBy: { createdAt: 'desc' },
          take: 10,
        });

        const activeNotification = recentNotifications.find((notification) => {
          const parsed = parseProfileViewNotificationData(notification);
          return (
            now.getTime() - parsed.windowStartedAt.getTime() <= PROFILE_VIEW_WINDOW_MS &&
            parsed.viewers.length < PROFILE_VIEW_BATCH_LIMIT
          );
        });

        if (activeNotification) {
          const parsed = parseProfileViewNotificationData(activeNotification);

          if (parsed.viewers.some((viewer) => viewer.id === viewerId)) {
            return null;
          }

          const viewers = [
            { id: viewerId, name: normalizedViewerName, sameCollege },
            ...parsed.viewers,
          ].slice(0, PROFILE_VIEW_BATCH_LIMIT);
          const copy = buildProfileViewNotificationCopy(viewers);
          const sameCollegeCount = viewers.filter((entry) => entry.sameCollege).length;
          const data = {
            screen: 'profile_views',
            batchKey: parsed.batchKey,
            windowStartedAt: parsed.windowStartedAt.toISOString(),
            lastViewedAt: now.toISOString(),
            viewerCount: viewers.length,
            sameCollegeCount,
            sameCollegeHint: sameCollege,
            latestViewerId: viewerId,
            latestViewerName: normalizedViewerName,
            viewers,
          };

          await tx.notifications.update({
            where: { id: activeNotification.id },
            data: {
              title: copy.title,
              body: copy.body,
              actorId: viewerId,
              data,
              isRead: false,
              readAt: null,
              createdAt: now,
            },
          });

          await enqueueNotificationCacheInvalidation(
            tx,
            userId,
            activeNotification.id,
            'notification.profile_view.updated'
          );

          return {
            title: copy.title,
            body: copy.body,
            batchKey: parsed.batchKey,
            viewerCount: viewers.length,
            latestViewerId: viewerId,
          };
        }

        const batchKey = `profile_view:${userId}:${now.getTime()}`;
        const viewers = [{ id: viewerId, name: normalizedViewerName, sameCollege }];
        const copy = buildProfileViewNotificationCopy(viewers);
        const notification = await tx.notifications.create({
          data: {
            userId,
            type: 'profile_view',
            title: copy.title,
            body: copy.body,
            actorId: viewerId,
            createdAt: now,
            data: {
              screen: 'profile_views',
              batchKey,
              windowStartedAt: now.toISOString(),
              lastViewedAt: now.toISOString(),
              viewerCount: 1,
              sameCollegeCount: sameCollege ? 1 : 0,
              sameCollegeHint: sameCollege,
              latestViewerId: viewerId,
              latestViewerName: normalizedViewerName,
              viewers,
            },
          },
          include: notificationInclude,
        });

        await enqueueNotificationCreatedEvents(tx, notification);
        await enqueueNotificationCacheInvalidation(
          tx,
          userId,
          notification.id,
          'notification.profile_view.created'
        );

        return {
          title: copy.title,
          body: copy.body,
          batchKey,
          viewerCount: 1,
          latestViewerId: viewerId,
        };
      });

      if (!delivery) {
        return;
      }

      await pushNotificationService.pushProfileView(userId, {
        title: delivery.title,
        body: delivery.body,
        viewerId: delivery.latestViewerId,
        batchKey: delivery.batchKey,
        viewerCount: delivery.viewerCount,
      });
    } catch (error) {
      console.error('Failed to send profile view notification:', error);
    }
  }
