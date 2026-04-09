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

export { io };
