import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma';
import { createCircle, joinCircle, leaveCircle } from '../modules/groups/services/circles/write.service';
import { getCircleAccess } from '../modules/groups/services/circles/access.service';
import { createGroupPostRecord, toggleGroupPostReaction, deleteGroupPostRecord } from '../modules/groups/services/group-posts.service';
import { getNotificationPreferences, updateNotificationPreferences } from '../modules/notifications/services/preferences.service';

// Opt-in tests may write only to an explicitly designated local fixture database.
const enabled = process.env.WEB_PERSISTENCE_INTEGRATION === 'true';
test('durable web contracts preserve privacy and serialize concurrent writes', { skip: !enabled }, async () => {
  const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
  assert.equal(url.pathname, '/vormex_validation');
  const prefix = `validation_${randomUUID().replace(/-/g, '')}`;
  const users = await Promise.all(['owner', 'member', 'outsider'].map(role => prisma.user.create({ data: {
    name: role, username: `${prefix}_${role}`, email: `${prefix}_${role}@example.invalid`,
  } })));
  const [owner, member, outsider] = users;
  const circleIds: string[] = [];
  let groupId: string | undefined;
  try {
    await Promise.all([
      updateNotificationPreferences(owner.id, { likes: false }),
      updateNotificationPreferences(owner.id, { messages: false }),
    ]);
    const persisted = await getNotificationPreferences(owner.id);
    assert.equal(persisted.likes, false);
    assert.equal(persisted.messages, false);
    assert.equal((await getNotificationPreferences(member.id)).likes, true);

    const { circle } = await createCircle(owner.id, { name: prefix, category: 'technology' });
    circleIds.push(circle.id);
    await prisma.circles.update({ where: { id: circle.id }, data: { maxMembers: 2 } });
    const joins = await Promise.allSettled([joinCircle(member.id, circle.id), joinCircle(outsider.id, circle.id)]);
    assert.equal(joins.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await prisma.circle_members.count({ where: { circleId: circle.id } }), 2);
    assert.equal((await prisma.circles.findUniqueOrThrow({ where: { id: circle.id } })).memberCount, 2);
    const winner = joins[0].status === 'fulfilled' ? member : outsider;
    await joinCircle(winner.id, circle.id);
    await leaveCircle(winner.id, circle.id);
    await leaveCircle(winner.id, circle.id);
    assert.equal((await prisma.circles.findUniqueOrThrow({ where: { id: circle.id } })).memberCount, 1);
    const privateCircle = await createCircle(owner.id, { name: `${prefix}_private`, category: 'technology', isPrivate: true });
    circleIds.push(privateCircle.circle.id);
    await assert.rejects(getCircleAccess(privateCircle.circle.id, outsider.id), { statusCode: 404 });
    await assert.rejects(joinCircle(outsider.id, privateCircle.circle.id), { statusCode: 403 });

    const group = await prisma.groups.create({ data: { id: randomUUID(), name: prefix, creatorId: owner.id, tags: [], isPrivate: true } });
    groupId = group.id;
    await prisma.group_members.create({ data: { id: randomUUID(), groupId, userId: member.id } });
    const post = await createGroupPostRecord(groupId, owner.id, { content: 'Persisted post' });
    assert.equal((await prisma.group_posts.findUniqueOrThrow({ where: { id: post.id } })).content, 'Persisted post');
    await assert.rejects(createGroupPostRecord(groupId, outsider.id, { content: 'Forbidden' }), { statusCode: 404 });
    await Promise.all([toggleGroupPostReaction(groupId, post.id, member.id), toggleGroupPostReaction(groupId, post.id, member.id)]);
    assert.equal((await prisma.group_posts.findUniqueOrThrow({ where: { id: post.id } })).likesCount, 0);
    assert.equal(await prisma.group_post_likes.count({ where: { postId: post.id } }), 0);
    await toggleGroupPostReaction(groupId, post.id, member.id);
    await assert.rejects(deleteGroupPostRecord(groupId, post.id, member.id), { statusCode: 403 });
    await deleteGroupPostRecord(groupId, post.id, owner.id);
    assert.equal(await prisma.group_post_likes.count({ where: { postId: post.id } }), 0);
  } finally {
    if (groupId) await prisma.groups.deleteMany({ where: { id: groupId } });
    await prisma.circles.deleteMany({ where: { id: { in: circleIds } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await prisma.$disconnect();
  }
});
