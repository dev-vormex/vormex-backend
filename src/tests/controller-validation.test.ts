import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerRequest, controllerResponse } from './helpers/controller-response';
import { searchMessages } from '../modules/chat/controllers/chat/message-read.controller';
import { postRewardEvent } from '../modules/engagement/controllers/engagement/rewards.controller';
import { createProject } from '../modules/profiles/controllers/professional-fields/projects.controller';
import { respondToPostCollabInvite } from '../modules/content/controllers/post/management.controller';
import * as rewards from '../modules/engagement/services/reward-cards.service';
import { normalizeProvider } from '../modules/skills/controllers/skills/support.controller';
import { prisma } from '../config/prisma';
import { mockPrismaMethod } from './helpers/prisma-mock';

test('missing and malformed chat search terms return 400 without querying messages', async (t) => {
  const reads = mockPrismaMethod(t, prisma.messages, 'findMany', () => {
    throw new Error('Unexpected database read');
  });
  for (const q of [undefined, null, {}, [], '   ']) {
    const { state, response } = controllerResponse();
    await searchMessages(controllerRequest({}, { q }), response);
    assert.equal(state.status, 400);
    assert.deepEqual(state.body, { error: 'Search query is required' });
  }
  assert.equal(reads.mock.callCount(), 0);
});

test('malformed reward events return 400 before recording side effects', async (t) => {
  const writes = t.mock.method(rewards, 'logRewardCardEvent', async () => {
    throw new Error('Unexpected reward write');
  });
  for (const body of [
    {},
    { sessionId: 'session-1' },
    { sessionId: 'session-1', cardId: 'card-1', action: 'viewed' },
    { sessionId: 'session-1', cardId: 'card-1', action: {} },
  ]) {
    const { state, response } = controllerResponse();
    await postRewardEvent(controllerRequest(body), response);
    assert.equal(state.status, 400);
  }
  assert.equal(writes.mock.callCount(), 0);
});

test('dismissed_all reward events do not require an unrelated card type or id', async (t) => {
  const writes = t.mock.method(rewards, 'logRewardCardEvent', async () => undefined);
  const { state, response } = controllerResponse();
  await postRewardEvent(controllerRequest({ sessionId: 'session-1', action: 'dismissed_all' }), response);
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, { success: true });
  assert.deepEqual(writes.mock.calls[0].arguments, [
    {
      userId: 'user-1',
      sessionId: 'session-1',
      action: 'dismissed_all',
      cardId: null,
      cardType: null,
    },
  ]);
});

test('missing or invalid project dates return 400 before any persistence', async (t) => {
  const writes = mockPrismaMethod(t, prisma.project, 'create', () => {
    throw new Error('Unexpected project write');
  });
  for (const body of [
    { name: 'Project' },
    { name: 'Project', startDate: 'invalid' },
    { name: 'Project', startDate: '2026-10-01', endDate: 'invalid' },
  ]) {
    const { state, response } = controllerResponse();
    await createProject(controllerRequest(body), response);
    assert.equal(state.status, 400);
  }
  assert.equal(writes.mock.callCount(), 0);
});

test('missing collaboration action returns validation failure instead of throwing', async () => {
  const { state, response } = controllerResponse();
  await respondToPostCollabInvite(controllerRequest({}, {}, { postId: 'post-1' }), response);
  assert.equal(state.status, 400);
  assert.deepEqual(state.body, { error: 'action must be "accept" or "reject"' });
});

test('optional skill providers normalize safely without accepting unknown providers', () => {
  assert.equal(normalizeProvider(undefined), '');
  assert.equal(normalizeProvider({}), '');
  assert.equal(normalizeProvider('unknown'), '');
  assert.equal(normalizeProvider('GITHUB'), 'github');
});
