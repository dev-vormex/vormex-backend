import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { ensureString } from '../utils/request.util';
import { getIO } from '../sockets';
import {
  ARCADE_CATALOG,
  abandonArcadeRoom,
  createArcadeRoom,
  finishArcadeRoom,
  getArcadeLeaderboard as getArcadeLeaderboardEntries,
  getArcadeRoomById,
  getArcadeRoomByInvite,
  joinArcadeRoom,
  listArcadeHistory,
  listArcadeRooms,
  serializeArcadeRoom,
  setArcadeReady,
} from '../services/arcade.service';

function getStatusCode(error: unknown): number {
  const statusCode = (error as { statusCode?: number })?.statusCode;
  return typeof statusCode === 'number' ? statusCode : 500;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getUserId(req: AuthenticatedRequest): string | null {
  return req.user?.userId ? String(req.user.userId) : null;
}

function emitArcadeRoomUpdated(room: any): void {
  const io = getIO();
  if (!io) {
    return;
  }

  const payload = { room: serializeArcadeRoom(room) };
  io.to(`arcade:${room.id}`).emit('arcade:room_updated', payload);
  io.to(`user:${room.hostId}`).emit('arcade:room_updated', payload);
  if (room.guestId) {
    io.to(`user:${room.guestId}`).emit('arcade:room_updated', payload);
  }
}

export const getArcadeCatalog = async (
  _req: AuthenticatedRequest,
  res: Response<{ games: typeof ARCADE_CATALOG } | ErrorResponse>
): Promise<void> => {
  res.status(200).json({ games: ARCADE_CATALOG });
};

export const getArcadeRooms = async (
  req: AuthenticatedRequest,
  res: Response<{ rooms: unknown[] } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req) || undefined;
    const rooms = await listArcadeRooms({
      gameType: req.query.gameType as string | undefined,
      limit: Number(req.query.limit) || 20,
    });

    res.status(200).json({
      rooms: rooms.map((room) => serializeArcadeRoom(room, userId)),
    });
  } catch (error) {
    console.error('Error fetching arcade rooms:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to fetch arcade rooms') });
  }
};

export const postArcadeRoom = async (
  req: AuthenticatedRequest,
  res: Response<{ room: unknown } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const room = await createArcadeRoom({
      userId,
      gameType: req.body?.gameType,
    });

    res.status(201).json({ room: serializeArcadeRoom(room, userId) });
  } catch (error) {
    console.error('Error creating arcade room:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to create arcade room') });
  }
};

export const getArcadeRoom = async (
  req: AuthenticatedRequest,
  res: Response<{ room: unknown } | ErrorResponse>
): Promise<void> => {
  try {
    const roomId = ensureString(req.params.roomId);
    if (!roomId) {
      res.status(400).json({ error: 'Room ID is required' });
      return;
    }

    const room = await getArcadeRoomById(roomId);
    if (!room) {
      res.status(404).json({ error: 'Arcade room not found' });
      return;
    }

    res.status(200).json({ room: serializeArcadeRoom(room, getUserId(req) || undefined) });
  } catch (error) {
    console.error('Error fetching arcade room:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to fetch arcade room') });
  }
};

export const getArcadeInvite = async (
  req: AuthenticatedRequest,
  res: Response<{ room: unknown } | ErrorResponse>
): Promise<void> => {
  try {
    const inviteCode = ensureString(req.params.inviteCode);
    if (!inviteCode) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const room = await getArcadeRoomByInvite(inviteCode);
    if (!room) {
      res.status(404).json({ error: 'Arcade room not found' });
      return;
    }

    res.status(200).json({ room: serializeArcadeRoom(room, getUserId(req) || undefined) });
  } catch (error) {
    console.error('Error fetching arcade invite:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to fetch arcade invite') });
  }
};

export const joinArcadeRoomById = async (
  req: AuthenticatedRequest,
  res: Response<{ room: unknown } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    const roomId = ensureString(req.params.roomId);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roomId) {
      res.status(400).json({ error: 'Room ID is required' });
      return;
    }

    const room = await joinArcadeRoom({ userId, roomId });
    emitArcadeRoomUpdated(room);
    res.status(200).json({ room: serializeArcadeRoom(room, userId) });
  } catch (error) {
    console.error('Error joining arcade room:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to join arcade room') });
  }
};

export const joinArcadeRoomByInvite = async (
  req: AuthenticatedRequest,
  res: Response<{ room: unknown } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    const inviteCode = ensureString(req.params.inviteCode);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!inviteCode) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const room = await joinArcadeRoom({ userId, inviteCode });
    emitArcadeRoomUpdated(room);
    res.status(200).json({ room: serializeArcadeRoom(room, userId) });
  } catch (error) {
    console.error('Error joining arcade invite:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to join arcade room') });
  }
};

export const readyArcadeRoom = async (
  req: AuthenticatedRequest,
  res: Response<{ room: unknown } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    const roomId = ensureString(req.params.roomId);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roomId) {
      res.status(400).json({ error: 'Room ID is required' });
      return;
    }

    const room = await setArcadeReady({
      userId,
      roomId,
      ready: req.body?.ready !== false,
    });
    emitArcadeRoomUpdated(room);
    res.status(200).json({ room: serializeArcadeRoom(room, userId) });
  } catch (error) {
    console.error('Error updating arcade ready state:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to update ready state') });
  }
};

export const finishArcadeRoomController = async (
  req: AuthenticatedRequest,
  res: Response<{ room: unknown } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    const roomId = ensureString(req.params.roomId);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roomId) {
      res.status(400).json({ error: 'Room ID is required' });
      return;
    }

    const room = await finishArcadeRoom({
      userId,
      roomId,
      hostScore: Number(req.body?.hostScore) || 0,
      guestScore: Number(req.body?.guestScore) || 0,
      durationSeconds: Number(req.body?.durationSeconds) || 0,
      metadata: req.body?.metadata,
    });
    emitArcadeRoomUpdated(room);
    res.status(200).json({ room: serializeArcadeRoom(room, userId) });
  } catch (error) {
    console.error('Error finishing arcade room:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to finish arcade room') });
  }
};

export const abandonArcadeRoomController = async (
  req: AuthenticatedRequest,
  res: Response<{ room: unknown } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    const roomId = ensureString(req.params.roomId);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roomId) {
      res.status(400).json({ error: 'Room ID is required' });
      return;
    }

    const room = await abandonArcadeRoom({ userId, roomId });
    emitArcadeRoomUpdated(room);
    res.status(200).json({ room: serializeArcadeRoom(room, userId) });
  } catch (error) {
    console.error('Error abandoning arcade room:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to abandon arcade room') });
  }
};

export const getArcadeHistory = async (
  req: AuthenticatedRequest,
  res: Response<{ results: unknown[] } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const results = await listArcadeHistory({
      userId,
      limit: Number(req.query.limit) || 20,
    });

    res.status(200).json({ results });
  } catch (error) {
    console.error('Error fetching arcade history:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to fetch arcade history') });
  }
};

export const getArcadeLeaderboard = async (
  req: AuthenticatedRequest,
  res: Response<{ leaderboard: unknown[] } | ErrorResponse>
): Promise<void> => {
  try {
    const leaderboard = await getArcadeLeaderboardEntries({
      gameType: req.query.gameType as string | undefined,
      limit: Number(req.query.limit) || 20,
    });

    res.status(200).json({ leaderboard });
  } catch (error) {
    console.error('Error fetching arcade leaderboard:', error);
    res.status(getStatusCode(error)).json({ error: getErrorMessage(error, 'Failed to fetch arcade leaderboard') });
  }
};
