import { processErrorCounter } from '../infrastructure/metrics/registry';
import { logger as defaultLogger } from '../lib/logger';

type ProcessEventName = 'unhandledRejection' | 'uncaughtException';

interface ProcessLike {
  on(event: ProcessEventName, listener: (...args: unknown[]) => void): unknown;
}

interface ErrorLogger {
  fatal(payload: Record<string, unknown>, message?: string): void;
  error(payload: Record<string, unknown>, message?: string): void;
}

export interface ProcessErrorHandlerOptions {
  exit?: (code: number) => void;
  logger?: ErrorLogger;
  processRef?: ProcessLike;
  shutdown: (reason: ProcessEventName, error: unknown) => Promise<void>;
}

function serializeProcessError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
    value: error,
  };
}

export function installProcessErrorHandlers(options: ProcessErrorHandlerOptions): void {
  const processRef = options.processRef || process;
  const log = options.logger || defaultLogger;
  const exit = options.exit || ((code: number) => process.exit(code));
  let fatalShutdownStarted = false;

  async function handleFatalProcessError(type: ProcessEventName, error: unknown): Promise<void> {
    processErrorCounter.inc({ type });

    const payload = {
      event: 'process.fatal_error',
      type,
      error: serializeProcessError(error),
    };

    if (type === 'uncaughtException') {
      log.fatal(payload, 'Uncaught exception; shutting down process.');
    } else {
      log.error(payload, 'Unhandled promise rejection; shutting down process.');
    }

    if (fatalShutdownStarted) {
      exit(1);
      return;
    }

    fatalShutdownStarted = true;

    try {
      await options.shutdown(type, error);
    } catch (shutdownError) {
      log.error({
        event: 'process.shutdown_failed',
        type,
        error: serializeProcessError(shutdownError),
      }, 'Graceful shutdown failed after fatal process error.');
    } finally {
      exit(1);
    }
  }

  processRef.on('uncaughtException', (error: unknown) => {
    void handleFatalProcessError('uncaughtException', error);
  });

  processRef.on('unhandledRejection', (reason: unknown) => {
    void handleFatalProcessError('unhandledRejection', reason);
  });
}

export { serializeProcessError };
