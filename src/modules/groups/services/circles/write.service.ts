import { randomUUID } from 'crypto';
import { prisma } from '../../../../config/prisma';
import { httpError } from '../../../../shared/utils/http-error.util';
import { circleUserSelect, circleView } from './access.service';

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string') {
    if (required) throw httpError(400, 'Required text is missing');
    return '';
  }
  const result = value.trim();
  if ((required && !result) || result.length > max)
    throw httpError(400, `Text must contain ${required ? '1' : '0'}–${max} characters`);
  return result;
}

export async function createCircle(userId: string, body: Record<string, unknown>) {
  const name = text(body.name, 100, true);
  const id = randomUUID();
  const slug = `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'circle'
  }-${id.slice(0, 8)}`;
  if (body.isPrivate !== undefined && typeof body.isPrivate !== 'boolean')
    throw httpError(400, 'isPrivate must be a boolean');
  if (
    body.tags !== undefined &&
    (!Array.isArray(body.tags) ||
      body.tags.length > 20 ||
      body.tags.some((t) => typeof t !== 'string' || t.length > 50))
  ) {
    throw httpError(400, 'Provide at most 20 text tags of 50 characters each');
  }
  const circle = await prisma.$transaction(async (tx) => {
    const created = await tx.circles.create({
      data: {
        id,
        name,
        slug,
        creatorId: userId,
        category: text(body.category, 60, true),
        description: text(body.description, 5000) || null,
        campus: text(body.campus, 120) || null,
        emoji: text(body.emoji, 20) || null,
        tags: (body.tags as string[] | undefined) ?? [],
        isPrivate: body.isPrivate === true,
        memberCount: 1,
      },
    });
    await tx.circle_members.create({ data: { circleId: id, userId, role: 'creator' } });
    return created;
  });
  return { circle: circleView(circle, userId) };
}

export async function joinCircle(userId: string, circleId: string) {
  // Lock the parent row: the membership check and capacity increment are atomic
  // across requests and across application instances.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM circles WHERE id = ${circleId} FOR UPDATE`;
    const circle = await tx.circles.findUnique({ where: { id: circleId } });
    if (!circle) throw httpError(404, 'Circle not found');
    const existing = await tx.circle_members.findUnique({ where: { circleId_userId: { circleId, userId } } });
    if (existing) return;
    if (circle.isPrivate && circle.creatorId !== userId) throw httpError(403, 'This circle requires an invitation');
    if (circle.memberCount >= circle.maxMembers) throw httpError(409, 'Circle is full');
    await tx.circle_members.create({ data: { circleId, userId } });
    await tx.circles.update({ where: { id: circleId }, data: { memberCount: { increment: 1 } } });
  });
  return { message: 'Joined circle' };
}

export async function leaveCircle(userId: string, circleId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM circles WHERE id = ${circleId} FOR UPDATE`;
    const circle = await tx.circles.findUnique({ where: { id: circleId } });
    if (!circle) throw httpError(404, 'Circle not found');
    if (circle.creatorId === userId) throw httpError(409, 'Circle owners cannot leave their circle');
    const removed = await tx.circle_members.deleteMany({ where: { circleId, userId } });
    if (removed.count) await tx.circles.update({ where: { id: circleId }, data: { memberCount: { decrement: 1 } } });
  });
  return { message: 'Left circle' };
}

export async function createCirclePost(userId: string, circleId: string, body: Record<string, unknown>) {
  const content = text(body.content, 10_000, true);
  if (
    body.mediaUrls !== undefined &&
    (!Array.isArray(body.mediaUrls) ||
      body.mediaUrls.length > 10 ||
      body.mediaUrls.some((u) => typeof u !== 'string' || !/^https:\/\//i.test(u) || u.length > 2048))
  ) {
    throw httpError(400, 'Provide at most 10 HTTPS media URLs');
  }
  const post = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM circles WHERE id = ${circleId} FOR UPDATE`;
    const member = await tx.circle_members.findUnique({ where: { circleId_userId: { circleId, userId } } });
    if (!member) throw httpError(403, 'Join the circle before posting');
    const created = await tx.circle_posts.create({
      data: {
        circleId,
        authorId: userId,
        content,
        type: text(body.type, 40) || 'discussion',
        mediaUrls: (body.mediaUrls as string[] | undefined) ?? [],
      },
    });
    await tx.circles.update({ where: { id: circleId }, data: { postsCount: { increment: 1 } } });
    return created;
  });
  const author = await prisma.user.findUnique({ where: { id: userId }, select: circleUserSelect });
  return { post: { ...post, author } };
}
