import { httpError } from '../../../shared/utils/http-error.util';

export const defaultNotificationPreferences = {
  pushEnabled: true,
  emailEnabled: true,
  emailDigestFrequency: 'daily',
  connections: true,
  messages: true,
  likes: true,
  comments: true,
  mentions: true,
  groups: true,
  jobs: true,
  learning: true,
  achievements: true,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  timeZone: 'UTC',
};
export type NotificationPreferences = typeof defaultNotificationPreferences;

const aliases: Record<string, keyof NotificationPreferences> = {
  messagesEnabled: 'messages',
  connectionsEnabled: 'connections',
  followsEnabled: 'connections',
  matchAlertsEnabled: 'connections',
  likesEnabled: 'likes',
  commentsEnabled: 'comments',
  mentionsEnabled: 'mentions',
  streakRemindersEnabled: 'achievements',
  likes: 'likes',
  comments: 'comments',
  mentions: 'mentions',
  follows: 'connections',
  email: 'emailEnabled',
  push: 'pushEnabled',
};

export function validatePreferencePatch(input: unknown): Partial<NotificationPreferences> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Settings must be an object');
  const source = input as Record<string, unknown>;
  const candidate = { ...source };
  for (const key of ['dailyDigestEnabled', 'weeklySummaryEnabled']) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean')
      throw httpError(400, `Invalid preference: ${key}`);
    delete candidate[key];
  }
  if (
    !Object.prototype.hasOwnProperty.call(source, 'emailDigestFrequency') &&
    ('dailyDigestEnabled' in source || 'weeklySummaryEnabled' in source)
  ) {
    if (source.dailyDigestEnabled === true && source.weeklySummaryEnabled === true)
      throw httpError(400, 'Choose one digest frequency');
    candidate.emailDigestFrequency =
      source.dailyDigestEnabled === true ? 'daily' : source.weeklySummaryEnabled === true ? 'weekly' : 'never';
  }
  const patch: Record<string, boolean | string> = {};
  for (const [inputKey, value] of Object.entries(candidate)) {
    const key = aliases[inputKey] ?? inputKey;
    if (!Object.prototype.hasOwnProperty.call(defaultNotificationPreferences, key))
      throw httpError(400, `Unknown preference: ${inputKey}`);
    const defaultValue = defaultNotificationPreferences[key as keyof NotificationPreferences];
    if (typeof value !== typeof defaultValue) throw httpError(400, `Invalid preference: ${inputKey}`);
    // Canonical values take precedence when an older client echoes GET aliases.
    if (inputKey !== key && Object.prototype.hasOwnProperty.call(candidate, key)) continue;
    if (typeof value === 'string') {
      if (key === 'emailDigestFrequency' && !['instant', 'daily', 'weekly', 'never'].includes(value))
        throw httpError(400, 'Invalid digest frequency');
      if (['quietHoursStart', 'quietHoursEnd'].includes(key) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
        throw httpError(400, 'Quiet hours must use HH:mm');
      if (key === 'timeZone') {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
        } catch {
          throw httpError(400, 'Invalid time zone');
        }
      }
    }
    patch[key] = value as string | boolean;
  }
  return patch as Partial<NotificationPreferences>;
}

export function notificationCategoryEnabled(settings: NotificationPreferences, type: string): boolean {
  const normalized = type.toLowerCase();
  const category = /mention/.test(normalized)
    ? 'mentions'
    : /group|circle/.test(normalized)
      ? 'groups'
      : /comment/.test(normalized)
        ? 'comments'
        : /like|reaction/.test(normalized)
          ? 'likes'
          : /message|chat/.test(normalized)
            ? 'messages'
            : /connection|follow|match/.test(normalized)
              ? 'connections'
              : /job|hackathon|opportunity/.test(normalized)
                ? 'jobs'
                : /learning|skill|course/.test(normalized)
                  ? 'learning'
                  : /streak|xp|achievement|reward/.test(normalized)
                    ? 'achievements'
                    : null;
  return category === null || settings[category];
}

export function isNotificationQuietTime(settings: NotificationPreferences, now = new Date()): boolean {
  if (!settings.quietHoursEnabled || settings.quietHoursStart === settings.quietHoursEnd) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const time = `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`;
  return settings.quietHoursStart < settings.quietHoursEnd
    ? time >= settings.quietHoursStart && time < settings.quietHoursEnd
    : time >= settings.quietHoursStart || time < settings.quietHoursEnd;
}
