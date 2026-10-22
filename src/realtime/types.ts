import type { Server, Socket } from 'socket.io';
import type { SocketContext } from './context';

export interface SocketHandlerInput {
  io: Server;
  socket: Socket;
  context: SocketContext;
}
