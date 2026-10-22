import type { SocketHandlerInput } from '../types';
import { buildAuthorizedPresenceRooms, buildCoarseSocketLocation, buildSocketLocationEventPayload, shouldThrottleSocketLocationUpdate, validateSocketLocationPayload } from '../../modules/proximity/utils/socket-location-events.util';
import { getBlockedUserIds } from '../../modules/safety/services/trust-safety.service';

export function registerLocationSocketHandlers({ socket, context }: SocketHandlerInput): void {
  const {
    socketLocationUpdateTimestamps,
    getSocketUserId,
    getAcceptedConnectionIdsForRealtime,
    getRealtimeLocationUser,
  } = context;

  // Location update
  socket.on('location:update', async (data) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Authentication required for location updates' });
      return;
    }

    const validation = validateSocketLocationPayload(data);
    if (!validation.ok) {
      socket.emit('error', { message: validation.error || 'Invalid location update payload' });
      return;
    }

    if (shouldThrottleSocketLocationUpdate(socketLocationUpdateTimestamps, userId)) {
      socket.emit('error', { message: 'Location updates are rate limited' });
      return;
    }

    try {
      const user = await getRealtimeLocationUser(userId);
      if (!user || user.shareLocationPublic !== true) {
        return;
      }

      const location = buildCoarseSocketLocation(validation.value || {}, user);
      const payload = buildSocketLocationEventPayload(user, location);
      if (!payload) {
        return;
      }

      const [acceptedConnectionIds, blockedUserIds] = await Promise.all([
        getAcceptedConnectionIdsForRealtime(user.id),
        getBlockedUserIds(user.id),
      ]);
      const blockedSet = new Set(blockedUserIds);
      const connectionIds = acceptedConnectionIds.filter((connectionId) => !blockedSet.has(connectionId));
      const blockedRooms = blockedUserIds.map((blockedId) => `user:${blockedId}`);
      const rooms = buildAuthorizedPresenceRooms(connectionIds, location);
      for (const room of rooms) {
        socket.to(room).except(blockedRooms).emit('user:location_changed', payload);
      }
    } catch (error) {
      console.error('location:update error:', error);
      socket.emit('error', { message: 'Failed to process location update' });
    }
  });
}
