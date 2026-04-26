import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';

interface CircleResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  coverImageUrl: string | null;
  emoji: string | null;
  category: string | null;
  campus: string | null;
  tags: string[];
  type: string | null;
  isPrivate: boolean;
  requiresApproval: boolean;
  maxMembers: number;
  memberCount: number;
  activeMembers: number;
  postsCount: number;
  weeklyActivity: number;
  isMember: boolean;
  myRole: string | null;
  createdAt: string | null;
}

const normalizeOptionalString = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeTags = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
    .slice(0, 20);
};

const slugifyCircleName = (name: string): string => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'circle';
};

const buildUniqueCircleSlug = async (circleId: string, name: string): Promise<string> => {
  const baseSlug = slugifyCircleName(name);
  let candidate = baseSlug;
  let suffix = 2;

  while (true) {
    const existing = await prisma.circles.findFirst({
      where: {
        slug: candidate,
        NOT: { id: circleId },
      },
      select: { id: true },
    });

    if (!existing) {
      return candidate;
    }

    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
};

const mapCircleResponse = (
  circle: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    imageUrl: string | null;
    coverImageUrl: string | null;
    emoji: string | null;
    category: string;
    campus: string | null;
    tags: string[];
    type: string;
    isPrivate: boolean;
    requiresApproval: boolean;
    maxMembers: number;
    memberCount: number;
    activeMembers: number;
    postsCount: number;
    weeklyActivity: number;
    createdAt: Date;
    creatorId: string | null;
  },
  userId: string,
  membershipRole: string | null
): CircleResponse => {
  const derivedRole = membershipRole ?? (circle.creatorId === userId ? 'creator' : null);
  return {
    id: circle.id,
    name: circle.name,
    slug: circle.slug,
    description: circle.description,
    imageUrl: circle.imageUrl,
    coverImageUrl: circle.coverImageUrl,
    emoji: circle.emoji,
    category: circle.category,
    campus: circle.campus,
    tags: circle.tags,
    type: circle.type,
    isPrivate: circle.isPrivate,
    requiresApproval: circle.requiresApproval,
    maxMembers: circle.maxMembers,
    memberCount: circle.memberCount,
    activeMembers: circle.activeMembers,
    postsCount: circle.postsCount,
    weeklyActivity: circle.weeklyActivity,
    isMember: Boolean(derivedRole),
    myRole: derivedRole,
    createdAt: circle.createdAt.toISOString(),
  };
};

/**
 * Update circle metadata and admin settings.
 * PUT /api/circles/:circleId
 */
export const updateCircle = async (
  req: AuthenticatedRequest,
  res: Response<CircleResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const circleId = ensureString(req.params.circleId);
    if (!circleId) {
      res.status(400).json({ error: 'Circle ID is required' });
      return;
    }

    const existingCircle = await prisma.circles.findUnique({
      where: { id: circleId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        imageUrl: true,
        coverImageUrl: true,
        emoji: true,
        category: true,
        campus: true,
        tags: true,
        type: true,
        isPrivate: true,
        requiresApproval: true,
        maxMembers: true,
        memberCount: true,
        activeMembers: true,
        postsCount: true,
        weeklyActivity: true,
        createdAt: true,
        creatorId: true,
      },
    });

    if (!existingCircle) {
      res.status(404).json({ error: 'Circle not found' });
      return;
    }

    const membership = await prisma.circle_members.findUnique({
      where: {
        circleId_userId: {
          circleId,
          userId,
        },
      },
      select: { role: true },
    });

    const membershipRole = membership?.role?.toLowerCase() ?? null;
    const isOwner = existingCircle.creatorId === userId || membershipRole === 'creator' || membershipRole === 'owner';
    if (!isOwner) {
      res.status(403).json({ error: 'Only circle owners can update this circle' });
      return;
    }

    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!rawName) {
      res.status(400).json({ error: 'Circle name is required' });
      return;
    }

    const requestedMaxMembers = req.body?.maxMembers;
    if (!Number.isInteger(requestedMaxMembers)) {
      res.status(400).json({ error: 'maxMembers must be an integer' });
      return;
    }

    const maxMembers = Number(requestedMaxMembers);
    if (maxMembers < existingCircle.memberCount) {
      res.status(400).json({ error: `maxMembers must be at least ${existingCircle.memberCount}` });
      return;
    }

    const description = normalizeOptionalString(req.body?.description);
    const emoji = normalizeOptionalString(req.body?.emoji);
    const category = normalizeOptionalString(req.body?.category);
    const tags = normalizeTags(req.body?.tags);
    const isPrivate = typeof req.body?.isPrivate === 'boolean' ? req.body.isPrivate : existingCircle.isPrivate;
    const requestedRequiresApproval =
      typeof req.body?.requiresApproval === 'boolean' ? req.body.requiresApproval : existingCircle.requiresApproval;
    const requiresApproval = isPrivate ? requestedRequiresApproval : false;
    const slug = await buildUniqueCircleSlug(circleId, rawName);

    const updatedCircle = await prisma.circles.update({
      where: { id: circleId },
      data: {
        name: rawName,
        slug,
        description: description === undefined ? existingCircle.description : description,
        emoji: emoji === undefined ? existingCircle.emoji : emoji,
        category: category ?? existingCircle.category,
        tags: tags ?? existingCircle.tags,
        isPrivate,
        requiresApproval,
        maxMembers,
        updatedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        imageUrl: true,
        coverImageUrl: true,
        emoji: true,
        category: true,
        campus: true,
        tags: true,
        type: true,
        isPrivate: true,
        requiresApproval: true,
        maxMembers: true,
        memberCount: true,
        activeMembers: true,
        postsCount: true,
        weeklyActivity: true,
        createdAt: true,
        creatorId: true,
      },
    });

    res.status(200).json(mapCircleResponse(updatedCircle, userId, membershipRole));
  } catch (error) {
    console.error('Error updating circle:', error);
    res.status(500).json({ error: 'Failed to update circle' });
  }
};
