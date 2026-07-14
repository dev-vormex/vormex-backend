import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function source(path: string): string {
  // Normalize CRLF so "\n"-based markers slice identically on Windows
  // working trees and CI.
  return readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `${start} not found`);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `${end} not found after ${start}`);
  return text.slice(startIndex, endIndex);
}

test('sendChatMessage writes message, conversation metadata, and outbox rows in one transaction', () => {
  const service = source('src/services/chat-message.service.ts');
  const transactionBlock = between(
    service,
    'return await prisma.$transaction(async (tx) => {',
    '}, {\n      maxWait: 15_000,'
  );

  assert.match(transactionBlock, /await tx\.messages\.create/);
  assert.match(transactionBlock, /await tx\.conversations\.update/);
  // All three chat side effects ride one batched outbox insert inside the tx.
  assert.match(transactionBlock, /await enqueueOutboxEvents\(tx, \[/);
  assert.match(transactionBlock, /queueName: queueNames\.realtimeFanout/);
  assert.match(transactionBlock, /queueName: queueNames\.notificationDelivery/);
  assert.match(transactionBlock, /queueName: queueNames\.cacheInvalidation/);
  assert.doesNotMatch(transactionBlock, /prisma\.(messages|conversations|outbox_events)/);
});

test('chat outbox events use deterministic idempotency keys only for chat side effects', () => {
  const service = source('src/services/chat-message.service.ts');

  assert.match(service, /idempotencyKey: `chat:realtime:\$\{messageId\}`/);
  assert.match(service, /idempotencyKey: `chat:push:\$\{messageId\}`/);
  assert.match(service, /idempotencyKey: `chat:cache:\$\{messageId\}`/);
});

test('duplicate clientMessageId path is race-safe and does not enqueue duplicate side effects', () => {
  const service = source('src/services/chat-message.service.ts');
  const duplicateBlock = between(
    service,
    'if (clientMessageId && isPrismaUniqueViolation(error)) {',
    'throw error;'
  );

  assert.match(duplicateBlock, /getExistingMessageResult/);
  assert.match(duplicateBlock, /return existing/);
  assert.doesNotMatch(duplicateBlock, /enqueueRealtimeFanout|enqueueNotificationDelivery|enqueueCacheInvalidation/);
});

test('socket chat send reuses shared service and has no inline push notification', () => {
  const indexSource = source('src/index.ts');
  const handler = between(
    indexSource,
    "socket.on('chat:send_message'",
    "  // Typing indicator"
  );

  assert.match(handler, /sendChatMessage/);
  assert.match(handler, /acknowledge\?\.\(\{ ok: true, message: result\.message \}\)/);
  assert.match(handler, /emitRealtimeEnvelopes\(result\.realtimeEnvelopes\)/);
  assert.doesNotMatch(handler, /pushNewMessage|pushNotificationService/);
  assert.doesNotMatch(handler, /prisma\.messages\.create|prisma\.conversations\.update/);
});

test('REST chat send reuses shared service and does not invalidate cache inline', () => {
  const controller = source('src/controllers/chat.controller.ts');
  const handler = between(
    controller,
    'export const sendMessage = async',
    'export const markAsRead = async'
  );

  assert.match(handler, /sendChatMessage/);
  assert.match(handler, /res\.status\(result\.wasDuplicate \? 200 : 201\)\.json\(result\.message\)/);
  assert.match(handler, /emitRealtimeEnvelopes\(result\.realtimeEnvelopes\)/);
  assert.doesNotMatch(handler, /invalidateChatCaches|cacheService\.invalidateTags|pushNewMessage/);
});

test('outbox idempotency migration and insert use partial unique key conflict handling', () => {
  const migration = source('prisma/migrations/20260608173000_chat_send_outbox_idempotency/migration.sql');
  const outbox = source('src/outbox/service.ts');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT/);
  assert.match(migration, /WHERE "idempotencyKey" IS NOT NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "messages_senderId_clientMessageId_key"/);
  assert.match(outbox, /ON CONFLICT \("idempotencyKey"\)/);
  assert.match(outbox, /DO NOTHING/);
});

test('one outbox event dispatches as one BullMQ job id', () => {
  const dispatcher = source('src/outbox/dispatcher.ts');

  assert.match(dispatcher, /jobId: event\.id/);
});
