import type { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma';
import { httpError } from '../../../../shared/utils/http-error.util';

export const circleUserSelect = {
  id: true,
  name: true,
  username: true,
  profileImage: true,
  headline: true,
  college: true,
} satisfies Prisma.UserSelect;

export async function getCircleAccess(circleId: string, userId: string) {
  const circle = await prisma.circles.findUnique({ where: { id: circleId } });
  if (!circle) throw httpError(404, 'Circle not found');
  const member = await prisma.circle_members.findUnique({
    where: { circleId_userId: { circleId, userId } },
  });
  const owner = circle.creatorId === userId;
  if (circle.isPrivate && !member && !owner) throw httpError(404, 'Circle not found');
  return { circle, member, owner };
}

export function circlePage(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

export function circleView<T extends { creatorId: string | null }>(
  circle: T,
  userId: string,
  membership?: { role: string } | null
) {
  const role = membership?.role ?? (circle.creatorId === userId ? 'creator' : null);
  return { ...circle, isMember: role !== null, myRole: role };
}
