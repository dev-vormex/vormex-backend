import { createHash } from 'crypto';

export interface ProximityFeatureFlags {
  entry: boolean; eventMode: boolean; publicPresence: boolean; liveMap: boolean;
  liveList: boolean; accumulation: boolean; summaryNotifications: boolean; persistence: boolean;
}

function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function getProximityFeatureFlags(): ProximityFeatureFlags {
  return getProximityFeatureFlagsForUser();
}

export function getProximityFeatureFlagsForUser(userId?: string, installId?: string): ProximityFeatureFlags {
  const flags = {
    entry: flag('CROSSED_PATHS_ENTRY_ENABLED'),
    eventMode: flag('CROSSED_PATHS_EVENT_MODE_ENABLED'),
    publicPresence: flag('CROSSED_PATHS_PUBLIC_PRESENCE_ENABLED'),
    liveMap: flag('CROSSED_PATHS_LIVE_MAP_ENABLED'),
    liveList: flag('CROSSED_PATHS_LIVE_LIST_ENABLED'),
    accumulation: flag('CROSSED_PATHS_ACCUMULATION_ENABLED'),
    summaryNotifications: flag('CROSSED_PATHS_SUMMARY_NOTIFICATIONS_ENABLED'),
    persistence: flag('CROSSED_PATHS_PERSISTENCE_ENABLED'),
  };
  if (!userId && !installId) return flags;
  const developmentAccounts = new Set(String(process.env.PROXIMITY_DEVELOPMENT_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
  const rolloutPercent = Math.max(0, Math.min(100, Number(process.env.PROXIMITY_ROLLOUT_PERCENT ?? 100)));
  const identity = userId || installId || '';
  const bucket = createHash('sha256').update(identity).digest().readUInt32BE(0) % 100;
  if (developmentAccounts.has(userId || '') || bucket < rolloutPercent) return flags;
  return { entry: false, eventMode: false, publicPresence: false, liveMap: false, liveList: false,
    accumulation: false, summaryNotifications: false, persistence: flags.persistence };
}
