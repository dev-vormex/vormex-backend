import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import { prisma } from '../config/prisma';
import { getCircleAccess } from '../modules/groups/services/circles/access.service';
import { joinCircle } from '../modules/groups/services/circles/write.service';
import type { Prisma } from '@prisma/client';

function mockDelegate<T extends (...args: never[]) => unknown>(context: TestContext,target:object,key:string,implementation:T){const delegate=target as Record<string,unknown>;const original=delegate[key];const mocked=context.mock.fn(implementation);delegate[key]=mocked;context.after(()=>{delegate[key]=original;});return mocked;}

test('private circles remain hidden from non-members, including detail/member/post access', async (context) => {

  mockDelegate(context, prisma.circles, 'findUnique', async () => ({ id: 'c1', isPrivate: true, creatorId: 'owner' }));
  mockDelegate(context, prisma.circle_members, 'findUnique', async () => null);
  await assert.rejects(getCircleAccess('c1', 'outsider'), { statusCode: 404 });
  assert.equal((await getCircleAccess('c1', 'owner')).owner, true);
});

test('circle join is idempotent and locks capacity before writing', async (context) => {

  const events: string[] = [];
  context.mock.method(prisma, '$transaction', async (operation: unknown) =>
    (operation as (tx: Prisma.TransactionClient) => Promise<unknown>)(prisma)
  );
  context.mock.method(prisma, '$queryRaw', async () => {
    events.push('lock');
    return [];
  });
  mockDelegate(context, prisma.circles, 'findUnique', async () => ({
    id: 'c1',
    isPrivate: false,
    creatorId: 'owner',
    memberCount: 2,
    maxMembers: 2,
  }));
  const membership = mockDelegate(
    context, prisma.circle_members,
    'findUnique',
    async (): Promise<{ id: string } | null> => ({ id: 'm1' })
  );
  const create = mockDelegate(context, prisma.circle_members, 'create', async () => {
    throw Error('Must not write');
  });
  await joinCircle('member', 'c1');
  assert.deepEqual(events, ['lock']);
  assert.equal(create.mock.callCount(), 0);
  membership.mock.mockImplementation(async () => null);
  await assert.rejects(joinCircle('outsider', 'c1'), { statusCode: 409 });
  assert.equal(create.mock.callCount(), 0);
});
