import type { Server as HttpServer } from 'http';
import { prisma, prismaRead, disconnectPrisma } from '../config/prisma';
import { assertRuntimeSchema } from '../config/runtime-schema';
import { logger } from '../infrastructure/logging/logger';
import { getAllQueues } from '../infrastructure/queue/queues';
import { disconnectRedisClients, isRedisRequired } from '../infrastructure/redis/client';
import { installProcessErrorHandlers } from './process-error-handlers.util';
import { connectProximityRedis, closeProximityRedis } from '../infrastructure/proximity/redis-client';
import { closeProximityQueues } from '../infrastructure/proximity/queues';

export function startApiLifecycle(
  server: HttpServer,
  redisStartupPromise: Promise<void>,
  HOST: string,
  PORT: string | number
): void {
  const handleStartupError = async (error: NodeJS.ErrnoException): Promise<void> => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      console.error(`Another process is already listening on http://${HOST}:${PORT}.`);
      console.error('Stop that process or run the backend on a different port, for example:');
      console.error('  PORT=5001 npm run dev');
    } else {
      console.error('Failed to start HTTP server:', error);
    }

    try {
      await disconnectPrisma();
      console.log('Database connection closed.');
    } catch (disconnectError) {
      console.error('Error closing database connection after startup failure:', disconnectError);
    }

    process.exit(1);
  };

  const onStartupError = (error: NodeJS.ErrnoException): void => {
    void handleStartupError(error);
  };

  server.once('error', onStartupError);

  async function startServer(): Promise<void> {
    try {
      await assertRuntimeSchema(prisma);
      if (prismaRead !== prisma) await assertRuntimeSchema(prismaRead, process.env.READ_DATABASE_URL);
    } catch (error) {
      console.error('Database startup check failed:', error instanceof Error ? error.message : 'Database unavailable');
      await disconnectPrisma();
      process.exit(1);
    }

    try {
      await redisStartupPromise;
    } catch (error) {
      if (isRedisRequired()) {
        console.error('Failed to initialize Redis realtime infrastructure:', error);
        await disconnectPrisma();
        process.exit(1);
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.warn({
        event: 'redis.api.disabled',
        message,
      });
    }

    // Optional and fault-isolated: proximity failure must never block the core API.
    await connectProximityRedis().catch((error) =>
      logger.warn({
        event: 'proximity.redis.disabled',
        message: error instanceof Error ? error.message : String(error),
      })
    );

    server.listen(Number(PORT), HOST, (): void => {
      server.removeListener('error', onStartupError);

      console.log(`
🚀 Server is running!
📍 Environment: ${process.env.NODE_ENV || 'development'}
🌐 Server URL: http://${HOST}:${PORT}
📊 Health Check: http://${HOST}:${PORT}/api/health
📚 API Docs: http://${HOST}:${PORT}/api-docs
🔌 WebSocket: ws://${HOST}:${PORT}
  `);
    });
  }

  // Start server
  void startServer();

  // Graceful shutdown
  let shutdownStarted = false;

  function closeHttpServer(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn({
          event: 'http_server.close_timeout',
          timeoutMs,
        });
        resolve();
      }, timeoutMs);

      server.close(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  const gracefulShutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    logger.info({
      event: 'process.shutdown.start',
      reason,
      exitCode,
    });

    try {
      await closeHttpServer();
      logger.info({ event: 'http_server.closed', reason });

      await disconnectRedisClients();
      await closeProximityQueues();
      await closeProximityRedis();
      await Promise.allSettled(getAllQueues().map((queue) => queue.close()));
      await disconnectPrisma();
      logger.info({
        event: 'process.shutdown.complete',
        reason,
        exitCode,
      });
      process.exit(exitCode);
    } catch (error) {
      logger.error({
        event: 'process.shutdown.error',
        reason,
        error,
      });
      process.exit(1);
    }
  };

  installProcessErrorHandlers({
    shutdown: async (reason) => {
      await gracefulShutdown(reason, 1);
    },
  });

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM', 0));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT', 0));
}
