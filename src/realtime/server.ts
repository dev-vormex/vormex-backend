import type { Server as HttpServer } from 'http';
import { isAllowedRequestOrigin } from '../config/http.config';
import { Server as SocketIOServer } from 'socket.io';
import { setIO } from './socket-registry';

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        callback(null, isAllowedRequestOrigin(origin));
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
    // Prefer WebSocket for low latency, while retaining Engine.IO polling for
    // networks/proxies that cannot complete a WebSocket upgrade.
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    maxHttpBufferSize: 256 * 1024,
  });

  // Share Socket.IO instance with controllers via the sockets module
  setIO(io);

  return io;
}
