import type { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma';
import { httpError } from '../../../../shared/utils/http-error.util';
import { getBlockedUserIds } from '../../../safety/services/trust-safety.service';
import { circlePage, circleUserSelect, circleView, getCircleAccess } from './access.service';

const PAGE_SIZE = 20;

export async function discoverCircles(userId: string, query: Record<string, unknown>) {
  const page = circlePage(query.page);
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 120) : '';
  const where: Prisma.circlesWhereInput = {
    OR: [{ isPrivate: false }, { creatorId: userId }, { circle_members: { some: { userId } } }],
    ...(typeof query.category === 'string' && query.category ? { category: query.category } : {}),
    ...(typeof query.campus === 'string' && query.campus ? { campus: query.campus } : {}),
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
  };
  const [circles, total] = await prisma.$transaction([
    prisma.circles.findMany({
      where,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: [{ memberCount: 'desc' }, { id: 'asc' }],
      include: { circle_members: { where: { userId }, select: { role: true } } },
    }),
    prisma.circles.count({ where }),
  ]);
  return {
    circles: circles.map(({ circle_members, ...circle }) => circleView(circle, userId, circle_members[0])),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
  };
}

export async function getMyCircles(userId: string) {
  const circles = await prisma.circles.findMany({
    where: { OR: [{ creatorId: userId }, { circle_members: { some: { userId } } }] },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: 500,
    include: { circle_members: { where: { userId }, select: { role: true } } },
  });
  return { circles: circles.map(({ circle_members, ...circle }) => circleView(circle, userId, circle_members[0])) };
}

export async function getCircleMembers(userId: string, circleId: string, pageValue: unknown) {
  await getCircleAccess(circleId, userId);
  const page = circlePage(pageValue);
  const blocked = await getBlockedUserIds(userId);
  const where: Prisma.circle_membersWhereInput = {
    circleId,
    userId: { notIn: blocked },
    users: { isBanned: false },
  };
  const [members, total] = await prisma.$transaction([
    prisma.circle_members.findMany({
      where,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: [{ xpInCircle: 'desc' }, { id: 'asc' }],
      include: { users: { select: circleUserSelect } },
    }),
    prisma.circle_members.count({ where }),
  ]);
  return {
    members: members.map(({ users, role, xpInCircle, joinedAt }) => ({ ...users, role, xpInCircle, joinedAt })),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
  };
}

export async function getCircleDetail(userId: string, slug: string) {
  const found = await prisma.circles.findUnique({ where: { slug }, select: { id: true } });
  if (!found) throw httpError(404, 'Circle not found');
  const { circle, member } = await getCircleAccess(found.id, userId);
  const { members, total } = await getCircleMembers(userId, found.id, 1);
  return {
    circle: {
      ...circleView(circle, userId, member),
      topMembers: members.slice(0, 5),
      _count: { circle_members: total, circle_posts: circle.postsCount },
    },
  };
}

export async function getCirclePosts(userId: string, circleId: string, pageValue: unknown) {
  await getCircleAccess(circleId, userId);
  const page = circlePage(pageValue);
  const blocked = await getBlockedUserIds(userId);
  const where = { circleId, authorId: { notIn: blocked } };
  const [posts, total] = await prisma.$transaction([
    prisma.circle_posts.findMany({
      where,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    }),
    prisma.circle_posts.count({ where }),
  ]);
  const authors = await prisma.user.findMany({
    where: { id: { in: [...new Set(posts.map((p) => p.authorId))] }, isBanned: false },
    select: circleUserSelect,
  });
  const byId = new Map(authors.map((author) => [author.id, author]));
  return {
    posts: posts.filter((p) => byId.has(p.authorId)).map((post) => ({ ...post, author: byId.get(post.authorId) })),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
  };
}
