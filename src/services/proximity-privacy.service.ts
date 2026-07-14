import { createHmac } from 'crypto';
import { prisma } from '../config/prisma';
import { proximityRedis } from '../infrastructure/proximity/redis-client';
import { proximityKeys } from '../infrastructure/proximity/redis-keys';
import type { ProximityMode } from '../types/proximity.types';

export function displaceMarker(input: {
  latitude: number; longitude: number; viewerId: string; targetId: string;
  viewerSessionId: string; targetGeneration: number; mode: ProximityMode;
}): { latitude: number; longitude: number } {
  const secret = process.env.PROXIMITY_MARKER_HMAC_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('PROXIMITY_MARKER_HMAC_SECRET is required');
  const digest = createHmac('sha256', secret)
    .update(`${input.viewerId}:${input.targetId}:${input.viewerSessionId}:${input.targetGeneration}`)
    .digest();
  const fraction = digest.readUInt32BE(0) / 0xffffffff;
  const angle = (digest.readUInt32BE(4) / 0xffffffff) * Math.PI * 2;
  const [minM, maxM] = input.mode === 'event' ? [30, 75] : [100, 200];
  const distance = minM + fraction * (maxM - minM);
  const angularDistance = distance / 6_371_000;
  const sourceLatitude = input.latitude * Math.PI / 180;
  const sourceLongitude = input.longitude * Math.PI / 180;
  const latitude = Math.asin(
    Math.sin(sourceLatitude) * Math.cos(angularDistance)
      + Math.cos(sourceLatitude) * Math.sin(angularDistance) * Math.cos(angle),
  );
  const longitude = sourceLongitude + Math.atan2(
    Math.sin(angle) * Math.sin(angularDistance) * Math.cos(sourceLatitude),
    Math.cos(angularDistance) - Math.sin(sourceLatitude) * Math.sin(latitude),
  );
  const normalizedLongitude = ((longitude * 180 / Math.PI + 540) % 360) - 180;
  return { latitude: latitude * 180 / Math.PI, longitude: normalizedLongitude };
}

export async function removeUserProximityPresence(userId: string): Promise<void> {
  if (!proximityRedis) return;
  const presenceRaw = await proximityRedis.get(proximityKeys.presence(userId)).catch(() => null);
  const pipeline = proximityRedis.pipeline();
  if (presenceRaw) {
    try {
      const presence = JSON.parse(presenceRaw) as { mode: ProximityMode; shard: string; cohort: number };
      pipeline.zrem(proximityKeys.geo(presence.mode, presence.shard), userId);
      pipeline.zrem(proximityKeys.geoCohort(presence.mode, presence.shard, presence.cohort), userId);
      pipeline.zrem(proximityKeys.lastSeen(presence.shard), userId);
    } catch { /* malformed expiring data is safe to discard */ }
  }
  pipeline.del(proximityKeys.presence(userId));
  await pipeline.exec().catch(() => undefined);
}

export async function invalidateUserProximity(userId: string, reason: string): Promise<void> {
  await prisma.proximity_sessions.updateMany({
    where: { userId, status: 'active' },
    data: { status: 'invalidated', endedAt: new Date(), endReason: reason.slice(0, 80) },
  });
  await removeUserProximityPresence(userId);
}
