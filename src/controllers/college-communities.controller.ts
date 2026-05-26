// @ts-nocheck
import { Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import { ensureString } from '../utils/request.util';
import { notificationService } from '../services/notification.service';

const userCardSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
  college: true,
  branch: true,
  graduationYear: true,
  isVerified: true,
};

function cleanText(value: unknown, max = 240): string {
  return (ensureString(value) || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanOptionalText(value: unknown, max = 240): string | null {
  const text = cleanText(value, max);
  return text || null;
}

function cleanList(value: unknown, maxItems = 8, maxLen = 80): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((item) => {
    const normalized = cleanText(item, maxLen).toLowerCase();
    if (normalized && normalized.includes('.') && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  });
  return result.slice(0, maxItems);
}

function normalizeCollege(value: unknown): string {
  return cleanText(value, 160);
}

function collegeKey(value: unknown): string {
  return normalizeCollege(value).toLowerCase();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || randomUUID().slice(0, 8);
}

async function uniqueGroupSlug(name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  let suffix = 2;
  while (await prisma.groups.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

async function uniqueCommunitySlug(college: string): Promise<string> {
  const base = slugify(`${college}-community`);
  let slug = base;
  let suffix = 2;
  while (await prisma.college_communities.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function formatCommunity(row: any, context: { membershipByCommunity?: Map<string, any>; verification?: any } = {}) {
  const membership = context.membershipByCommunity?.get(row.id) || null;
  return {
    id: row.id,
    college: row.college,
    slug: row.slug,
    description: row.description,
    groupId: row.groupId,
    emailDomains: row.emailDomains,
    verificationMode: row.verificationMode,
    memberCount: row.memberCount,
    isMember: Boolean(membership),
    memberRole: membership?.role || null,
    verificationStatus: context.verification?.status || null,
    canJoin: Boolean(context.verification?.status === 'verified' || membership),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function formatVerification(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    college: row.college,
    studentEmail: row.studentEmail,
    status: row.status,
    method: row.method,
    verifiedAt: row.verifiedAt?.toISOString?.() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getCollegeVerification(userId: string, college: string) {
  const normalizedCollege = normalizeCollege(college);
  if (!normalizedCollege) return null;
  return prisma.college_student_verifications.findUnique({
    where: { userId_college: { userId, college: normalizedCollege } },
  });
}

async function ensureProfileCollegeVerification(userId: string, college: string) {
  const normalizedCollege = normalizeCollege(college);
  if (!normalizedCollege) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, college: true, email: true, isVerified: true },
  });
  if (!user) return null;

  const existing = await getCollegeVerification(userId, normalizedCollege);
  if (existing?.status === 'verified') return existing;

  const profileMatches = collegeKey(user.college) === collegeKey(normalizedCollege);
  if (!profileMatches) return existing;

  return prisma.college_student_verifications.upsert({
    where: { userId_college: { userId, college: normalizedCollege } },
    create: {
      userId,
      college: normalizedCollege,
      status: 'verified',
      method: user.isVerified ? 'verified_profile_college' : 'profile_college',
      verifiedAt: new Date(),
    },
    update: {
      status: 'verified',
      method: user.isVerified ? 'verified_profile_college' : 'profile_college',
      verifiedAt: new Date(),
    },
  });
}

export const listCollegeCommunities = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const search = cleanText(req.query.search || req.query.q, 120);
    const mine = req.query.mine === 'true';
    const where: any = {};
    if (search) {
      where.OR = [
        { college: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (mine && userId) {
      where.members = { some: { userId } };
    }

    const communities = await prisma.college_communities.findMany({
      where,
      orderBy: [{ memberCount: 'desc' }, { college: 'asc' }],
      take: 80,
    });

    const memberships = userId && communities.length
      ? await prisma.college_community_members.findMany({
          where: { userId, communityId: { in: communities.map((community) => community.id) } },
        })
      : [];
    const verifications = userId && communities.length
      ? await prisma.college_student_verifications.findMany({
          where: { userId, college: { in: communities.map((community) => community.college) } },
        })
      : [];
    const membershipByCommunity = new Map(memberships.map((membership) => [membership.communityId, membership]));
    const verificationByCollege = new Map(verifications.map((verification) => [collegeKey(verification.college), verification]));

    res.json({
      communities: communities.map((community) => formatCommunity(community, {
        membershipByCommunity,
        verification: verificationByCollege.get(collegeKey(community.college)),
      })),
    });
  } catch (error) {
    console.error('listCollegeCommunities error:', error);
    res.status(500).json({ error: 'Failed to load college communities' });
  }
};

export const createCollegeCommunity = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const college = normalizeCollege(req.body.college);
    if (!college) {
      res.status(400).json({ error: 'College is required' });
      return;
    }

    const existing = await prisma.college_communities.findFirst({
      where: { college: { equals: college, mode: 'insensitive' } },
    });
    if (existing) {
      const verification = await ensureProfileCollegeVerification(userId, existing.college);
      const membership = await prisma.college_community_members.findUnique({
        where: { communityId_userId: { communityId: existing.id, userId } },
      });
      res.json({
        community: formatCommunity(existing, {
          membershipByCommunity: new Map(membership ? [[existing.id, membership]] : []),
          verification,
        }),
        created: false,
      });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: userCardSelect });
    const groupId = randomUUID();
    const groupName = `${college} Community`;
    const groupSlug = await uniqueGroupSlug(groupName);
    const communitySlug = await uniqueCommunitySlug(college);
    const emailDomains = cleanList(req.body.emailDomains, 8, 80);
    const description = cleanOptionalText(
      req.body.description || `Private space for verified ${college} students.`,
      600
    );

    const community = await prisma.$transaction(async (tx) => {
      await tx.groups.create({
        data: {
          id: groupId,
          name: groupName,
          slug: groupSlug,
          description,
          creatorId: userId,
          isPrivate: true,
          memberCount: 1,
          maxMembers: 10000,
          tags: ['college', college],
          updatedAt: new Date(),
          group_members: {
            create: {
              id: randomUUID(),
              userId,
              role: 'owner',
            },
          },
        },
      });

      const created = await tx.college_communities.create({
        data: {
          college,
          slug: communitySlug,
          description,
          groupId,
          emailDomains,
          memberCount: 1,
          createdById: userId,
          members: {
            create: {
              userId,
              role: 'owner',
            },
          },
        },
      });

      await tx.college_student_verifications.upsert({
        where: { userId_college: { userId, college } },
        create: {
          userId,
          college,
          status: 'verified',
          method: user?.isVerified ? 'verified_creator' : 'community_creator',
          verifiedAt: new Date(),
        },
        update: {
          status: 'verified',
          method: user?.isVerified ? 'verified_creator' : 'community_creator',
          verifiedAt: new Date(),
        },
      });

      return created;
    });

    const membership = await prisma.college_community_members.findUnique({
      where: { communityId_userId: { communityId: community.id, userId } },
    });
    const verification = await getCollegeVerification(userId, college);
    res.status(201).json({
      community: formatCommunity(community, {
        membershipByCommunity: new Map(membership ? [[community.id, membership]] : []),
        verification,
      }),
      created: true,
    });
  } catch (error) {
    console.error('createCollegeCommunity error:', error);
    res.status(500).json({ error: 'Failed to create college community' });
  }
};

export const verifyCollegeStudent = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const college = normalizeCollege(req.body.college);
    if (!college) {
      res.status(400).json({ error: 'College is required' });
      return;
    }

    const studentEmail = cleanOptionalText(req.body.studentEmail, 160);
    const community = await prisma.college_communities.findFirst({
      where: { college: { equals: college, mode: 'insensitive' } },
    });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, college: true, isVerified: true },
    });

    const profileMatches = collegeKey(user?.college) === collegeKey(college);
    const studentEmailDomain = studentEmail?.split('@')[1]?.toLowerCase() || null;
    const domainMatches = Boolean(
      studentEmailDomain &&
        community?.emailDomains?.some((domain: string) => domain.toLowerCase() === studentEmailDomain)
    );
    const ownsEmail = Boolean(studentEmail && user?.email?.toLowerCase() === studentEmail.toLowerCase());
    const verified = profileMatches || (domainMatches && ownsEmail);

    const verification = await prisma.college_student_verifications.upsert({
      where: { userId_college: { userId, college } },
      create: {
        userId,
        college,
        studentEmail,
        status: verified ? 'verified' : 'pending',
        method: verified
          ? profileMatches
            ? (user?.isVerified ? 'verified_profile_college' : 'profile_college')
            : 'campus_email'
          : 'manual_review',
        verifiedAt: verified ? new Date() : null,
      },
      update: {
        studentEmail,
        status: verified ? 'verified' : 'pending',
        method: verified
          ? profileMatches
            ? (user?.isVerified ? 'verified_profile_college' : 'profile_college')
            : 'campus_email'
          : 'manual_review',
        verifiedAt: verified ? new Date() : null,
      },
    });

    res.json({ verification: formatVerification(verification) });
  } catch (error) {
    console.error('verifyCollegeStudent error:', error);
    res.status(500).json({ error: 'Failed to verify college student status' });
  }
};

export const joinCollegeCommunity = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const communityId = cleanText(req.params.communityId, 120);
    const community = await prisma.college_communities.findFirst({
      where: { OR: [{ id: communityId }, { slug: communityId }] },
    });
    if (!community) {
      res.status(404).json({ error: 'Community not found' });
      return;
    }

    const verification = await ensureProfileCollegeVerification(userId, community.college);
    if (verification?.status !== 'verified') {
      res.status(403).json({
        error: `Verify your ${community.college} student status before joining.`,
        code: 'college_verification_required',
        verification: formatVerification(verification),
      });
      return;
    }

    const [membership] = await prisma.$transaction(async (tx) => {
      const member = await tx.college_community_members.upsert({
        where: { communityId_userId: { communityId: community.id, userId } },
        create: {
          communityId: community.id,
          userId,
          role: 'member',
        },
        update: {},
      });

      await tx.group_members.upsert({
        where: { groupId_userId: { groupId: community.groupId, userId } },
        create: {
          id: randomUUID(),
          groupId: community.groupId,
          userId,
          role: 'member',
        },
        update: {},
      });

      const count = await tx.college_community_members.count({ where: { communityId: community.id } });
      await tx.college_communities.update({
        where: { id: community.id },
        data: { memberCount: count },
      });
      await tx.groups.update({
        where: { id: community.groupId },
        data: { memberCount: count },
      }).catch(() => null);

      return [member, count];
    });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: userCardSelect });
    if (community.createdById && community.createdById !== userId) {
      notificationService.notifyCollegeCommunityJoined(community.createdById, userId, {
        memberName: user?.name || 'Someone',
        college: community.college,
        communityId: community.id,
        groupId: community.groupId,
      }).catch(console.error);
    }

    res.json({
      community: formatCommunity(community, {
        membershipByCommunity: new Map([[community.id, membership]]),
        verification,
      }),
    });
  } catch (error) {
    console.error('joinCollegeCommunity error:', error);
    res.status(500).json({ error: 'Failed to join community' });
  }
};

export const getMyCollegeVerification = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const college = normalizeCollege(req.query.college);
    const verifications = college
      ? await prisma.college_student_verifications.findMany({ where: { userId, college } })
      : await prisma.college_student_verifications.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } });
    res.json({ verifications: verifications.map(formatVerification) });
  } catch (error) {
    console.error('getMyCollegeVerification error:', error);
    res.status(500).json({ error: 'Failed to load college verification' });
  }
};
