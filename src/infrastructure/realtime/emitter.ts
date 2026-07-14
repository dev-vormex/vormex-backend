import type { Server } from 'socket.io';
import { getIO } from '../../sockets';
import { markEnvelopeEmitted, type RealtimeEnvelope } from './channels';
import { logger } from '../../lib/logger';

// Per-instance guard against the same envelope being emitted twice to local
// sockets (immediate API emit + outbox replay). Cross-instance suppression is
// handled by the Redis emitted-marker (see channels.ts) and by the subscriber
// emitting locally only.
const recentlyEmitted = new Map<string, number>();
const RECENT_EMIT_TTL_MS = 120_000;
const RECENT_EMIT_MAX_ENTRIES = 10_000;

const EMIT_ROOM_DIAGNOSTICS_ENABLED =
  (process.env.REALTIME_EMIT_DIAGNOSTICS || '').toLowerCase() === 'true';

function wasRecentlyEmitted(dedupeKey: string): boolean {
  const now = Date.now();
  const expiresAt = recentlyEmitted.get(dedupeKey);
  if (expiresAt && expiresAt > now) {
    return true;
  }

  if (recentlyEmitted.size >= RECENT_EMIT_MAX_ENTRIES) {
    for (const [key, expiry] of recentlyEmitted) {
      if (expiry <= now) {
        recentlyEmitted.delete(key);
      }
    }
    while (recentlyEmitted.size >= RECENT_EMIT_MAX_ENTRIES) {
      const oldest = recentlyEmitted.keys().next().value;
      if (oldest === undefined) break;
      recentlyEmitted.delete(oldest);
    }
  }

  recentlyEmitted.set(dedupeKey, now + RECENT_EMIT_TTL_MS);
  return false;
}

function chatPayloadWithEmitTimestamp(envelope: RealtimeEnvelope): Record<string, unknown> {
  if (!envelope.event.startsWith('chat:')) {
    return envelope.payload;
  }

  return {
    ...envelope.payload,
    serverEmittedAtMs: Date.now(),
  };
}

function roomNamesForEnvelope(envelope: RealtimeEnvelope): string[] {
  return [
    ...(envelope.rooms || []),
    ...(envelope.users || []).map((userId) => `user:${userId}`),
  ];
}

function logRealtimeEmit(io: Server, envelope: RealtimeEnvelope, payload: Record<string, unknown>): void {
  if (!envelope.event.startsWith('chat:')) {
    return;
  }

  const rooms = roomNamesForEnvelope(envelope);
  const localRoomCounts = Object.fromEntries(
    rooms.map((room) => [room, io.sockets.adapter.rooms.get(room)?.size || 0])
  );
  const message = payload.message && typeof payload.message === 'object'
    ? payload.message as { id?: string; clientMessageId?: string }
    : undefined;

  logger.info({
    event: 'realtime.emit',
    socketEvent: envelope.event,
    conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : undefined,
    messageId: message?.id,
    clientMessageId: message?.clientMessageId,
    rooms,
    users: envelope.users || [],
    localRoomCounts,
    serverEmittedAtMs: payload.serverEmittedAtMs,
  });

  // allSockets() is a cross-instance round-trip per emit under the Redis
  // adapter, so it stays opt-in for debugging sessions only.
  if (!EMIT_ROOM_DIAGNOSTICS_ENABLED) {
    return;
  }

  void Promise.all(
    rooms.map(async (room) => [room, (await io.in(room).allSockets()).size] as const)
  )
    .then((counts) => {
      logger.info({
        event: 'realtime.emit.room_counts',
        socketEvent: envelope.event,
        conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : undefined,
        messageId: message?.id,
        allRoomCounts: Object.fromEntries(counts),
      });
    })
    .catch((error) => {
      logger.warn({
        event: 'realtime.emit.room_count_failed',
        socketEvent: envelope.event,
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

export type EmitRealtimeOptions = {
  /**
   * Deliver to sockets connected to this instance only. Used by the pub/sub
   * subscriber: the publish already reached every instance, so re-emitting
   * through the Redis adapter would multiply deliveries.
   */
  localOnly?: boolean;
};

export function emitRealtimeEnvelopeToServer(
  io: Server,
  envelope: RealtimeEnvelope,
  options: EmitRealtimeOptions = {}
): void {
  if (envelope.dedupeKey && wasRecentlyEmitted(envelope.dedupeKey)) {
    logger.debug?.({
      event: 'realtime.emit.deduped',
      socketEvent: envelope.event,
      dedupeKey: envelope.dedupeKey,
    });
    return;
  }

  const payload = chatPayloadWithEmitTimestamp(envelope);
  logRealtimeEmit(io, envelope, payload);

  const scope = options.localOnly ? io.local : io;

  if (envelope.broadcast) {
    scope.emit(envelope.event, payload);
  }

  // Single union broadcast: Socket.IO delivers once per socket across the
  // room list. Emitting per room instead sends duplicates to any socket in
  // several target rooms (e.g. a chat room and its own user room).
  const rooms = roomNamesForEnvelope(envelope);
  if (rooms.length > 0) {
    scope.to(rooms).emit(envelope.event, payload);
  }

  if (envelope.dedupeKey && !options.localOnly) {
    markEnvelopeEmitted(envelope.dedupeKey);
  }
}

export function emitRealtimeEnvelope(envelope: RealtimeEnvelope): boolean {
  const io = getIO();
  if (!io) {
    return false;
  }

  emitRealtimeEnvelopeToServer(io, envelope);
  return true;
}

export function emitRealtimeEnvelopes(envelopes: RealtimeEnvelope[]): boolean {
  const io = getIO();
  if (!io) {
    return false;
  }

  for (const envelope of envelopes) {
    emitRealtimeEnvelopeToServer(io, envelope);
  }

  return true;
}
