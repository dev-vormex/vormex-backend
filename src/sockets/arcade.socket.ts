import type { Server, Socket } from 'socket.io';
import {
  createArcadeRoom,
  getArcadeRoomById,
  getArcadeRoomByInvite,
  joinArcadeRoom,
  listArcadeRooms,
  normalizeArcadeRoomStatus,
  patchRuntimeState,
  serializeArcadeRoom,
  setArcadeReady,
} from '../services/arcade.service';

type GetSocketUserId = (socket: Socket) => string | null;

function emitArcadeError(socket: Socket, message: string): void {
  socket.emit('arcade:error', { message });
}

function isParticipant(room: any, userId: string): boolean {
  return room.hostId === userId || room.guestId === userId;
}

function roomName(roomId: string): string {
  return `arcade:${roomId}`;
}

export function registerArcadeSocketHandlers(input: {
  io: Server;
  socket: Socket;
  getSocketUserId: GetSocketUserId;
}): void {
  const { io, socket, getSocketUserId } = input;

  socket.on('arcade:join_room', async (payload: { roomId?: string; inviteCode?: string } = {}) => {
    try {
      const userId = getSocketUserId(socket);
      if (!userId) {
        emitArcadeError(socket, 'Not authenticated');
        return;
      }

      const requestedRoom = payload.roomId
        ? await getArcadeRoomById(String(payload.roomId))
        : payload.inviteCode
          ? await getArcadeRoomByInvite(String(payload.inviteCode))
          : null;

      if (!requestedRoom) {
        emitArcadeError(socket, 'Arcade room not found');
        return;
      }

      const room = isParticipant(requestedRoom, userId)
        ? requestedRoom
        : await joinArcadeRoom({
            userId,
            roomId: requestedRoom.id,
          });

      socket.join(roomName(room.id));
      const serializedRoom = serializeArcadeRoom(room, userId);
      io.to(roomName(room.id)).emit('arcade:room_updated', { room: serializedRoom });
      socket.emit('arcade:joined', { room: serializedRoom });
    } catch (error) {
      emitArcadeError(socket, error instanceof Error ? error.message : 'Failed to join arcade room');
    }
  });

  socket.on('arcade:quick_match', async (payload: { gameType: string }) => {
    try {
      const userId = getSocketUserId(socket);
      if (!userId) {
        emitArcadeError(socket, 'Not authenticated');
        return;
      }

      let room;
      const waitingRooms = await listArcadeRooms({ gameType: payload.gameType, limit: 1 });
      if (waitingRooms.length > 0) {
        room = await joinArcadeRoom({ userId, roomId: waitingRooms[0].id });
      } else {
        room = await createArcadeRoom({ userId, gameType: payload.gameType });
      }

      socket.join(roomName(room.id));
      const serializedRoom = serializeArcadeRoom(room, userId);
      io.to(roomName(room.id)).emit('arcade:room_updated', { room: serializedRoom });
      socket.emit('arcade:joined', { room: serializedRoom });
    } catch (error) {
      emitArcadeError(socket, error instanceof Error ? error.message : 'Failed to quick match');
    }
  });

  socket.on('arcade:ready', async (payload: { roomId?: string; ready?: boolean } = {}) => {
    try {
      const userId = getSocketUserId(socket);
      const roomId = String(payload.roomId || '');
      if (!userId || !roomId) {
        emitArcadeError(socket, 'Room and authentication are required');
        return;
      }

      const room = await setArcadeReady({
        userId,
        roomId,
        ready: payload.ready !== false,
      });

      const serializedRoom = serializeArcadeRoom(room, userId);
      io.to(roomName(room.id)).emit('arcade:room_updated', { room: serializedRoom });
      if (room.status === 'in_progress') {
        io.to(roomName(room.id)).emit('arcade:countdown', { startsAt: Date.now() + 3_000 });
      }
    } catch (error) {
      emitArcadeError(socket, error instanceof Error ? error.message : 'Failed to update ready state');
    }
  });

  socket.on('arcade:input', async (payload: { roomId?: string; type?: string; data?: unknown } = {}) => {
    try {
      const userId = getSocketUserId(socket);
      const roomId = String(payload.roomId || '');
      if (!userId || !roomId) {
        emitArcadeError(socket, 'Room and authentication are required');
        return;
      }

      const room = await getArcadeRoomById(roomId);
      if (!room || !isParticipant(room, userId)) {
        emitArcadeError(socket, 'Arcade room not found');
        return;
      }

      const state = await patchRuntimeState(room, {
        status: normalizeArcadeRoomStatus(room.status),
        payload: {
          userId,
          type: payload.type || 'input',
          data: payload.data,
          sentAt: new Date().toISOString(),
        },
      });

      io.to(roomName(room.id)).emit('arcade:state', {
        roomId: room.id,
        fromUserId: userId,
        type: payload.type || 'input',
        data: payload.data,
        state,
      });
    } catch (error) {
      emitArcadeError(socket, error instanceof Error ? error.message : 'Failed to send arcade input');
    }
  });

  socket.on('arcade:leave_room', (payload: { roomId?: string } = {}) => {
    const roomId = String(payload.roomId || '');
    if (!roomId) {
      return;
    }

    socket.leave(roomName(roomId));
    socket.to(roomName(roomId)).emit('arcade:presence', {
      roomId,
      userId: getSocketUserId(socket),
      status: 'left',
    });
  });
}
