import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from '../infrastructure/metrics/registry';
import {
  executeWithCircuitBreaker,
  isThirdPartyHttpError,
  resetHttpCircuitBreakersForTests,
} from '../utils/http-client-with-breaker.util';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('slow provider trips the operation timeout', async () => {
  resetHttpCircuitBreakersForTests();
  const startedAt = Date.now();

  await assert.rejects(
    executeWithCircuitBreaker(
      'test_timeout_provider',
      'slow_call',
      async () => {
        await sleep(250);
        return 'late';
      },
      {
        failureThreshold: 5,
        cooldownMs: 1_000,
        requestTimeoutMs: 25,
      }
    ),
    (error: unknown) => {
      assert.equal(isThirdPartyHttpError(error), true);
      assert.equal((error as Error & { code: string }).code, 'third_party_timeout');
      return true;
    }
  );

  assert.ok(Date.now() - startedAt < 150);
});

test('repeated failures open the breaker and subsequent calls fail fast', async () => {
  resetHttpCircuitBreakersForTests();
  let attempts = 0;
  const failingCall = () =>
    executeWithCircuitBreaker(
      'test_open_provider',
      'unstable_call',
      async () => {
        attempts += 1;
        throw new Error('provider failed');
      },
      {
        failureThreshold: 2,
        cooldownMs: 1_000,
        requestTimeoutMs: 100,
      }
    );

  await assert.rejects(failingCall);
  await assert.rejects(failingCall);

  const startedAt = Date.now();
  await assert.rejects(
    failingCall,
    (error: unknown) => {
      assert.equal(isThirdPartyHttpError(error), true);
      assert.equal((error as Error & { code: string }).code, 'third_party_circuit_open');
      return true;
    }
  );

  assert.ok(Date.now() - startedAt < 50);
  assert.equal(attempts, 2);
});

test('breaker half-open probe recovers after cooldown', async () => {
  resetHttpCircuitBreakersForTests();
  let shouldFail = true;
  const callProvider = () =>
    executeWithCircuitBreaker(
      'test_recovery_provider',
      'recovering_call',
      async () => {
        if (shouldFail) {
          throw new Error('provider failed');
        }
        return 'ok';
      },
      {
        failureThreshold: 1,
        cooldownMs: 30,
        requestTimeoutMs: 100,
      }
    );

  await assert.rejects(callProvider);
  await assert.rejects(callProvider, /circuit is open/);

  shouldFail = false;
  await sleep(40);
  assert.equal(await callProvider(), 'ok');
  assert.equal(await callProvider(), 'ok');
});

test('third-party metrics include success timeout and open outcomes', async () => {
  resetHttpCircuitBreakersForTests();

  await executeWithCircuitBreaker(
    'test_metrics_provider',
    'success_call',
    async () => 'ok',
    { requestTimeoutMs: 100 }
  );

  await assert.rejects(
    executeWithCircuitBreaker(
      'test_metrics_provider',
      'timeout_call',
      async () => {
        await sleep(200);
      },
      {
        failureThreshold: 1,
        cooldownMs: 1_000,
        requestTimeoutMs: 20,
      }
    )
  );

  await assert.rejects(
    executeWithCircuitBreaker(
      'test_metrics_provider',
      'timeout_call',
      async () => undefined,
      {
        failureThreshold: 1,
        cooldownMs: 1_000,
        requestTimeoutMs: 20,
      }
    )
  );

  const metrics = await register.metrics();
  assert.match(metrics, /vormex_third_party_http_total\{provider="test_metrics_provider",operation="success_call",outcome="success"\}/);
  assert.match(metrics, /vormex_third_party_http_total\{provider="test_metrics_provider",operation="timeout_call",outcome="timeout"\}/);
  assert.match(metrics, /vormex_third_party_http_total\{provider="test_metrics_provider",operation="timeout_call",outcome="open"\}/);
});
