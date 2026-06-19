import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from '../infrastructure/metrics/registry';
import { installProcessErrorHandlers } from '../utils/process-error-handlers.util';

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('uncaughtException logs, increments metrics, runs shutdown, and exits non-zero', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const logs: Array<{ level: string; payload: Record<string, unknown>; message?: string }> = [];
  const shutdowns: Array<{ reason: string; error: unknown }> = [];
  const exits: number[] = [];
  const error = new Error('boom');

  installProcessErrorHandlers({
    processRef: {
      on(event, listener) {
        listeners.set(event, listener);
      },
    },
    logger: {
      fatal(payload, message) {
        logs.push({ level: 'fatal', payload, message });
      },
      error(payload, message) {
        logs.push({ level: 'error', payload, message });
      },
    },
    shutdown: async (reason, shutdownError) => {
      shutdowns.push({ reason, error: shutdownError });
    },
    exit: (code) => {
      exits.push(code);
    },
  });

  listeners.get('uncaughtException')?.(error);
  await waitForMicrotasks();

  assert.deepEqual(shutdowns, [{ reason: 'uncaughtException', error }]);
  assert.deepEqual(exits, [1]);
  assert.equal(logs[0].level, 'fatal');
  assert.equal(logs[0].payload.type, 'uncaughtException');
  assert.match(await register.metrics(), /vormex_process_error_total\{type="uncaughtException"\}/);
});

test('unhandledRejection uses the same fail-fast shutdown policy', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const shutdowns: string[] = [];
  const exits: number[] = [];
  const reason = new Error('async boom');

  installProcessErrorHandlers({
    processRef: {
      on(event, listener) {
        listeners.set(event, listener);
      },
    },
    logger: {
      fatal() {},
      error() {},
    },
    shutdown: async (shutdownReason) => {
      shutdowns.push(shutdownReason);
    },
    exit: (code) => {
      exits.push(code);
    },
  });

  listeners.get('unhandledRejection')?.(reason);
  await waitForMicrotasks();

  assert.deepEqual(shutdowns, ['unhandledRejection']);
  assert.deepEqual(exits, [1]);
  assert.match(await register.metrics(), /vormex_process_error_total\{type="unhandledRejection"\}/);
});
