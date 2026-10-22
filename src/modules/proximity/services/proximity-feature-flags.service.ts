export interface ProximityFeatureFlags {
  entry: boolean; eventMode: boolean; publicPresence: boolean; liveMap: boolean;
  liveList: boolean; accumulation: boolean; summaryNotifications: boolean; persistence: boolean;
}

function enabled(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function getProximityFeatureFlags(): ProximityFeatureFlags {
  return getProximityFeatureFlagsForUser();
}

export function getProximityFeatureFlagsForUser(_userId?: string, _installId?: string): ProximityFeatureFlags {
  // Crossed Paths is fully launched. Legacy rollout variables may still exist
  // as false values in an older deployment, so they must no longer disable the
  // product. Keep one explicit emergency switch for an operational shutdown.
  const available = !enabled(process.env.CROSSED_PATHS_FORCE_DISABLED);
  return {
    entry: available,
    eventMode: available,
    publicPresence: available,
    liveMap: available,
    liveList: available,
    accumulation: available,
    summaryNotifications: available,
    persistence: available,
  };
}
