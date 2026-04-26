import type { Server } from 'socket.io';
import { getIO } from '../../sockets';
import type { RealtimeEnvelope } from './channels';

export function emitRealtimeEnvelopeToServer(io: Server, envelope: RealtimeEnvelope): void {
  if (envelope.broadcast) {
    io.emit(envelope.event, envelope.payload);
  }

  for (const room of envelope.rooms || []) {
    io.to(room).emit(envelope.event, envelope.payload);
  }

  for (const userId of envelope.users || []) {
    io.to(`user:${userId}`).emit(envelope.event, envelope.payload);
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
