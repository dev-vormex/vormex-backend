import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampPageSize,
  createdAtDescKeysetWhere,
  decodeKeysetCursor,
  encodeKeysetCursor,
  numberDescDateDescIdDescWhere,
} from '../utils/keyset-pagination.util';

async function withCursorSecret<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = process.env.PAGINATION_CURSOR_SECRET;
  try {
    process.env.PAGINATION_CURSOR_SECRET = 'test-pagination-cursor-secret';
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.PAGINATION_CURSOR_SECRET;
    } else {
      process.env.PAGINATION_CURSOR_SECRET = original;
    }
  }
}

test('keyset cursors are opaque, scoped, and tamper-resistant', async () => {
  await withCursorSecret(() => {
    const cursor = encodeKeysetCursor({
      scope: 'chat.messages:conversation-1',
      id: 'message-1',
      t: '2026-06-08T10:00:00.000Z',
    });

    assert.doesNotMatch(cursor, /message-1/);
    assert.deepEqual(decodeKeysetCursor(cursor, 'chat.messages:conversation-1'), {
      scope: 'chat.messages:conversation-1',
      id: 'message-1',
      t: '2026-06-08T10:00:00.000Z',
    });
    assert.equal(decodeKeysetCursor(cursor, 'chat.messages:conversation-2'), null);
    assert.equal(decodeKeysetCursor(`${cursor.slice(0, -1)}x`, 'chat.messages:conversation-1'), null);
  });
});

test('createdAt keyset predicate pages older rows without overlap under inserts', async () => {
  await withCursorSecret(() => {
    const firstPage = [
      { id: 'post-c', createdAt: '2026-06-08T10:00:00.000Z' },
      { id: 'post-b', createdAt: '2026-06-08T10:00:00.000Z' },
    ];
    const cursor = encodeKeysetCursor({
      scope: 'feed.latest',
      id: firstPage[1].id,
      t: firstPage[1].createdAt,
    });
    const predicate = createdAtDescKeysetWhere(decodeKeysetCursor(cursor, 'feed.latest'));

    assert.deepEqual(predicate, {
      OR: [
        { createdAt: { lt: new Date('2026-06-08T10:00:00.000Z') } },
        { createdAt: new Date('2026-06-08T10:00:00.000Z'), id: { lt: 'post-b' } },
      ],
    });
  });
});

test('numeric duration cursor preserves stable descending tie-breakers', async () => {
  await withCursorSecret(() => {
    const encoded = encodeKeysetCursor({
      scope: 'proximity-history:duration',
      id: 'encounter-b',
      n: 720,
      t: '2026-07-13T10:00:00.000Z',
    });
    const decoded = decodeKeysetCursor(encoded, 'proximity-history:duration');
    assert.equal(decoded?.n, 720);
    assert.deepEqual(numberDescDateDescIdDescWhere(decoded, 'duration', 'lastSeenAt'), {
      OR: [
        { duration: { lt: 720 } },
        { duration: 720, lastSeenAt: { lt: new Date('2026-07-13T10:00:00.000Z') } },
        { duration: 720, lastSeenAt: new Date('2026-07-13T10:00:00.000Z'), id: { lt: 'encounter-b' } },
      ],
    });
  });
});

test('page size is capped server-side', () => {
  assert.equal(clampPageSize('5000', 20, 50), 50);
  assert.equal(clampPageSize('0', 20, 50), 1);
  assert.equal(clampPageSize(undefined, 20, 50), 20);
});
