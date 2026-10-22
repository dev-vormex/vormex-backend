import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Prisma } from '@prisma/client';
import { prismaWrite } from '../config/prisma';
import * as queues from '../infrastructure/queue/queues';
import { queueNames, type QueueName } from '../infrastructure/queue/queue-names';
import { dispatchOutboxBatch } from '../infrastructure/outbox/dispatcher';
import { outboxDispatchCounter } from '../infrastructure/metrics/registry';
import { logger } from '../infrastructure/logging/logger';

function eventRow(queueName: QueueName = queueNames.mediaProcessing) {
  return {
    id: 'outbox-1',
    aggregateType: 'post',
    aggregateId: 'post-1',
    eventType: 'post.created',
    queueName,
    payload: { postId: 'post-1' },
    attempts: 0,
    createdAt: new Date(),
    claimedAt: new Date(),
  };
}

function mockDispatch(t: TestContext, row = eventRow(), affected = 1) {
  const reads = t.mock.method(prismaWrite, '$queryRaw', async () => [row]);
  const writes = t.mock.method(prismaWrite, '$executeRaw', async () => affected);
  const add = t.mock.fn(async (..._args: unknown[]) => undefined);
  t.mock.method(queues, 'getQueue', () => ({ add }));
  const metrics = t.mock.method(outboxDispatchCounter, 'inc', () => undefined);
  const warnings = t.mock.method(logger, 'warn', () => undefined);
  t.mock.method(logger, 'error', () => undefined);
  return { reads, writes, add, metrics, warnings };
}

test('recovered claims enqueue the original event shape with its stable deduplication id', async (t) => {
  const row = eventRow();
  const { add, writes, metrics } = mockDispatch(t, row);
  assert.equal(await dispatchOutboxBatch(), 1);
  const { claimedAt: _claim, ...event } = row;
  assert.deepEqual(add.mock.calls[0].arguments, [row.eventType, { event }, { jobId: row.id }]);
  const update = writes.mock.calls[0].arguments[0] as Prisma.Sql;
  assert.match(update.sql, /status = 'published'/);
  assert.match(update.sql, /status = 'processing' AND "updatedAt" =/);
  assert.ok(update.values.includes(row.claimedAt));
  assert.deepEqual(metrics.mock.calls[0].arguments, [{ status: 'published', queue: row.queueName }]);
});

test('queue failure releases only the current claim and preserves the retry delay', async (t) => {
  const row = eventRow();
  const { writes, metrics } = mockDispatch(t, row);
  t.mock.method(queues, 'getQueue', () => {
    throw new Error('Queue unavailable');
  });
  const before = Date.now();
  await dispatchOutboxBatch();
  const after = Date.now();
  const update = writes.mock.calls[0].arguments[0] as Prisma.Sql;
  assert.match(update.sql, /status = 'pending'/);
  assert.match(update.sql, /attempts = attempts \+ 1/);
  assert.match(update.sql, /status = 'processing' AND "updatedAt" =/);
  const retryAt = update.values.find((value) => value instanceof Date && value !== row.claimedAt) as Date;
  assert.ok(retryAt.getTime() >= before + 5000 && retryAt.getTime() <= after + 5000);
  assert.ok(update.values.includes('Queue unavailable'));
  assert.deepEqual(metrics.mock.calls[0].arguments, [{ status: 'failed', queue: row.queueName }]);
});

test('a stale dispatcher cannot report a newer claim as published or failed', async (t) => {
  for (const failed of [false, true]) {
    const { metrics, warnings, writes } = mockDispatch(t, eventRow(), 0);
    if (failed)
      t.mock.method(queues, 'getQueue', () => {
        throw new Error('Unavailable');
      });
    await dispatchOutboxBatch();
    assert.equal(writes.mock.callCount(), 1);
    assert.equal(metrics.mock.callCount(), 0);
    assert.equal(
      (warnings.mock.calls[0].arguments[0] as unknown as { event: string }).event,
      'outbox.dispatch.claim_lost'
    );
    t.mock.restoreAll();
  }
});

test('expired recovered events are terminal without enqueueing and remain claim guarded', async (t) => {
  const row = { ...eventRow(queueNames.realtimeFanout), createdAt: new Date(0) };
  const { add, writes, metrics } = mockDispatch(t, row);
  await dispatchOutboxBatch();
  assert.equal(add.mock.callCount(), 0);
  const update = writes.mock.calls[0].arguments[0] as Prisma.Sql;
  assert.ok(update.values.includes('expired'));
  assert.ok(update.values.includes(row.claimedAt));
  assert.match(update.sql, /status = 'processing' AND "updatedAt" =/);
  assert.deepEqual(metrics.mock.calls[0].arguments, [{ status: 'expired', queue: row.queueName }]);
});

test('claim selection locks rows, recovers expired processing leases and bounds batch sizes', async (t) => {
  const reads = t.mock.method(prismaWrite, '$queryRaw', async () => []);
  for (const [limit, expected] of [
    [2.9, 2],
    [500, 200],
    [0, 1],
    [NaN, 50],
    [Infinity, 50],
  ]) {
    assert.equal(await dispatchOutboxBatch(limit), 0);
    const query = reads.mock.calls.at(-1)!.arguments[0] as Prisma.Sql;
    assert.match(query.sql, /status = 'pending' AND "availableAt" <= NOW\(\)/);
    assert.match(query.sql, /status = 'processing'/);
    assert.match(query.sql, /"updatedAt" <= NOW\(\) -/);
    assert.match(query.sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(query.sql, /AS "claimedAt"/);
    assert.equal(query.values.at(-1), expected);
    assert.ok(Number(query.values[0]) >= 30_000);
  }
});
