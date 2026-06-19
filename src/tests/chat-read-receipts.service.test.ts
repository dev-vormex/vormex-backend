import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canViewerSeeReadReceipt,
  maskReadReceiptForViewer,
  shouldNotifySenderAboutReadReceipt,
} from '../services/chat-read-receipts.service';

test('free senders do not see read receipts for their own messages', () => {
  const message = maskReadReceiptForViewer(
    {
      senderId: 'sender-1',
      status: 'READ',
      readAt: '2026-06-01T10:00:00.000Z',
    },
    'sender-1',
    false
  );

  assert.equal(message.status, 'SENT');
  assert.equal(message.readAt, null);
});

test('premium senders can see read receipts for their own messages', () => {
  const message = maskReadReceiptForViewer(
    {
      senderId: 'sender-1',
      status: 'READ',
      readAt: '2026-06-01T10:00:00.000Z',
    },
    'sender-1',
    true
  );

  assert.equal(message.status, 'READ');
  assert.equal(message.readAt, '2026-06-01T10:00:00.000Z');
});

test('receivers can see their own incoming message read state without premium', () => {
  assert.equal(
    canViewerSeeReadReceipt({
      viewerUserId: 'receiver-1',
      messageSenderId: 'sender-1',
      viewerCanUseReadReceipts: false,
    }),
    true
  );
});

test('read receipt notifications only emit for premium senders with updated messages', () => {
  assert.equal(
    shouldNotifySenderAboutReadReceipt({ updatedCount: 1, senderCanUseReadReceipts: true }),
    true
  );
  assert.equal(
    shouldNotifySenderAboutReadReceipt({ updatedCount: 1, senderCanUseReadReceipts: false }),
    false
  );
  assert.equal(
    shouldNotifySenderAboutReadReceipt({ updatedCount: 0, senderCanUseReadReceipts: true }),
    false
  );
});
