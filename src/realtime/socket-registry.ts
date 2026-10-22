import { Server } from 'socket.io';

/**
 * Socket.IO Server Instance
 * This will be initialized in the main server file
 * For now, export a placeholder that can be set later
 */

let io: Server | null = null;

export const setIO = (socketServer: Server) => {
  io = socketServer;
};

export const getIO = (): Server | null => {
  return io;
};

/** Immediately revoke every active socket for a user from a group room. */
export async function evictUserFromGroupRoom(groupId: string, userId: string): Promise<void> {
  if (!io) return;
  await io.in(`user:${userId}`).socketsLeave(`group:${groupId}`);
  io.to(`user:${userId}`).emit('group:membership_revoked', { groupId });
}

export { io };
