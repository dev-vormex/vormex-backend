export const PROXIMITY_API_VERSION = 1 as const;
export type ProximityMode = 'event' | 'public';
export type ProximityDegradedMode = 'none' | 'live_unavailable' | 'history_lagging';

export interface ProximitySampleInput {
  sampleId: string;
  capturedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  speedMps?: number;
  movement?: 'stationary' | 'walking' | 'moving' | 'unknown';
}

export interface ProximityHeartbeatInput extends ProximitySampleInput {
  sessionId: string;
  generation: number;
  sequence: number;
}

export interface ProximityPresence {
  userId: string;
  mode: ProximityMode;
  sessionId: string;
  generation: number;
  sequence: number;
  sampleId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAtMs: number;
  serverSeenAtMs: number;
  radiusM: number;
  shard: string;
  cohort: number;
}

export interface ProximityHeartbeatResponse {
  version: 1;
  accepted: boolean;
  duplicate: boolean;
  nearbyCount: number;
  nearbyCountCapped: boolean;
  nextHeartbeatAfterSeconds: number;
  sessionExpiresAt: string;
  degradedMode: ProximityDegradedMode;
  historyLagging: boolean;
}

export interface ProximityErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  };
}

export interface AccumulateHeartbeatJob {
  version: 1;
  sessionId: string;
  generation: number;
  sequence: number;
  sampleId: string;
  userId: string;
  candidateUserIds: string[];
}

export interface EncounterDelta {
  version: 1;
  flushId: string;
  lowerUserId: string;
  higherUserId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  durationSeconds: number;
  sampleCount: number;
  minimumDistanceM: number;
  encounterIncrement: number;
  areaLabel?: string;
}
