import type { Prisma } from '@prisma/client';
import { prisma } from '../../../config/prisma';
import {
  defaultNotificationPreferences,
  validatePreferencePatch,
  type NotificationPreferences,
} from './preferences-policy.service';

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const stored = await prisma.notification_preferences.findUnique({ where: { userId } });
  return { ...defaultNotificationPreferences, ...(stored ? validatePreferencePatch(stored.settings) : {}) };
}

export async function updateNotificationPreferences(userId: string, input: unknown): Promise<NotificationPreferences> {
  const patch = validatePreferencePatch(input);
  return prisma.$transaction(async (tx) => {
    // Locking the existing user also serializes the first settings insert, so two
    // tabs updating different preference fields cannot lose each other's edits.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const stored = await tx.notification_preferences.findUnique({ where: { userId } });
    const settings = {
      ...defaultNotificationPreferences,
      ...(stored ? validatePreferencePatch(stored.settings) : {}),
      ...patch,
    };
    await tx.notification_preferences.upsert({
      where: { userId },
      create: { userId, settings: settings as Prisma.InputJsonObject },
      update: { settings: settings as Prisma.InputJsonObject },
    });
    return settings;
  });
}

export function legacyNotificationSettings(settings: NotificationPreferences) {
  return {
    ...settings,
    messagesEnabled: settings.messages,
    connectionsEnabled: settings.connections,
    likesEnabled: settings.likes,
    commentsEnabled: settings.comments,
    mentionsEnabled: settings.mentions,
    followsEnabled: settings.connections,
    matchAlertsEnabled: settings.connections,
    streakRemindersEnabled: settings.achievements,
    dailyDigestEnabled: settings.emailEnabled && settings.emailDigestFrequency === 'daily',
    weeklySummaryEnabled: settings.emailEnabled && settings.emailDigestFrequency === 'weekly',
  };
}
