import type { Server } from 'socket.io';
import { getIO } from '../../sockets';
import type { RealtimeEnvelope } from './channels';
import { logger } from '../../lib/logger';

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

export function emitRealtimeEnvelopeToServer(io: Server, envelope: RealtimeEnvelope): void {
  const payload = chatPayloadWithEmitTimestamp(envelope);
  logRealtimeEmit(io, envelope, payload);

  if (envelope.broadcast) {
    io.emit(envelope.event, payload);
  }

  for (const room of envelope.rooms || []) {
    io.to(room).emit(envelope.event, payload);
  }

  for (const userId of envelope.users || []) {
    io.to(`user:${userId}`).emit(envelope.event, payload);
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
