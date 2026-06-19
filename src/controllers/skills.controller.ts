// @ts-nocheck
import { Response } from 'express';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import { ensureString } from '../utils/request.util';
import { isUUID } from '../utils/username.util';
import { notificationService } from '../services/notification.service';
import { getPremiumAccessSnapshot } from '../services/premium-access.service';

const MAX_SKILL_LENGTH = 80;
const DEFAULT_SESSION_LENGTH = 30;

const userCardSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
  college: true,
  branch: true,
  graduationYear: true,
  isOnline: true,
  lastActiveAt: true,
};

function normalizeSkillName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SKILL_LENGTH);
}

function skillKey(value: string): string {
  return normalizeSkillName(value).toLowerCase();
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const normalized = normalizeSkillName(value);
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  });
  return result;
}

function overlaps(left: string[], right: string[]): boolean {
  const rightKeys = right.map(skillKey).filter(Boolean);
  return left.some((item) => {
    const leftKey = skillKey(item);
    return rightKeys.some((rightKey) => leftKey.includes(rightKey) || rightKey.includes(leftKey));
  });
}

function evidenceMatchesSkill(evidenceSkill: string, skill: string): boolean {
  const left = skillKey(evidenceSkill);
  const right = skillKey(skill);
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

function formatUserCard(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    profileImage: user.profileImage,
    headline: user.headline,
    college: user.college,
    branch: user.branch,
    graduationYear: user.graduationYear,
    isOnline: Boolean(user.isOnline),
    lastActiveAt: user.lastActiveAt?.toISOString?.() ?? user.lastActiveAt ?? null,
  };
}

function skillSwapDisplayName(user: any, fallback = 'Someone') {
  return ensureString(user?.name) || ensureString(user?.username) || fallback;
}

async function resolveUser(identifier: string, requestingUserId: string | null) {
  let userId = ensureString(identifier);
  if (!userId) return null;
  if (userId.startsWith('@')) userId = userId.slice(1);
  if (userId.toLowerCase() === 'me') {
    if (!requestingUserId) return null;
    userId = requestingUserId;
  }

  return prisma.user.findFirst({
    where: isUUID(userId) ? { id: userId } : { username: userId.toLowerCase() },
    select: {
      ...userCardSelect,
      bio: true,
      interests: true,
      githubConnected: true,
      githubUsername: true,
      githubProfileUrl: true,
      user_onboarding: {
        select: {
          wantToLearn: true,
          canTeach: true,
          primaryGoal: true,
          lookingFor: true,
        },
      },
      skills: {
        select: {
          id: true,
          proficiency: true,
          yearsOfExp: true,
          createdAt: true,
          skill: { select: { id: true, name: true, category: true } },
        },
      },
      projects: {
        orderBy: [{ featured: 'desc' }, { updatedAt: 'desc' }],
        select: {
          id: true,
          name: true,
          description: true,
          role: true,
          techStack: true,
          projectUrl: true,
          githubUrl: true,
          featured: true,
          updatedAt: true,
          createdAt: true,
        },
      },
      certificates: {
        orderBy: { issueDate: 'desc' },
        select: {
          id: true,
          name: true,
          issuingOrg: true,
          credentialUrl: true,
          issueDate: true,
          createdAt: true,
        },
      },
      experiences: {
        orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
        select: {
          id: true,
          title: true,
          company: true,
          skills: true,
          isCurrent: true,
          startDate: true,
          createdAt: true,
        },
      },
      achievements: {
        orderBy: { date: 'desc' },
        select: {
          id: true,
          title: true,
          type: true,
          organization: true,
          description: true,
          certificateUrl: true,
          date: true,
          createdAt: true,
        },
      },
      githubStats: {
        select: {
          topLanguages: true,
          topRepos: true,
          totalPublicRepos: true,
          totalStars: true,
          lastCalculatedAt: true,
        },
      },
    },
  });
}

async function findOrCreateSkill(name: string) {
  const normalized = normalizeSkillName(name);
  if (!normalized) {
    throw new Error('Skill is required');
  }

  const existing = await prisma.skill.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
  });
  if (existing) return existing;

  return prisma.skill.create({
    data: { name: normalized },
  });
}

function safeJsonArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function topLanguageName(item: any): string {
  return normalizeSkillName(item?.name || item?.language || item?.label || item?.key || '');
}

function topRepoSkills(item: any): string[] {
  const values = [
    item?.language,
    ...(Array.isArray(item?.languages) ? item.languages : []),
    ...(Array.isArray(item?.topics) ? item.topics : []),
  ];
  return uniqueStrings(values);
}

function buildPassport(user: any, endorsements: any[], verificationLinks: any[] = [], accessSnapshot?: any) {
  const aggregates = new Map<string, any>();
  const allEvidence: any[] = [];
  const onboarding = user.user_onboarding;
  const wantToLearn = uniqueStrings(onboarding?.wantToLearn);
  const canTeach = uniqueStrings(onboarding?.canTeach);

  const ensureAggregate = (name: string, seed: any = {}) => {
    const normalized = normalizeSkillName(name);
    if (!normalized) return null;
    const key = skillKey(normalized);
    const current = aggregates.get(key);
    if (current) {
      Object.assign(current, {
        id: current.id || seed.id,
        category: current.category || seed.category || null,
        proficiency: current.proficiency || seed.proficiency || null,
        yearsOfExp: current.yearsOfExp ?? seed.yearsOfExp ?? null,
      });
      return current;
    }
    const created = {
      id: seed.id || `virtual:${key}`,
      name: normalized,
      category: seed.category || null,
      proficiency: seed.proficiency || null,
      yearsOfExp: seed.yearsOfExp ?? null,
      canTeach: canTeach.some((skill) => evidenceMatchesSkill(skill, normalized)),
      wantsToLearn: wantToLearn.some((skill) => evidenceMatchesSkill(skill, normalized)),
      evidence: [],
      endorsements: [],
      sources: new Set<string>(),
    };
    aggregates.set(key, created);
    return created;
  };

  const addEvidence = (skillName: string, evidence: any) => {
    const aggregate = ensureAggregate(skillName);
    if (!aggregate) return;
    const fullEvidence = {
      ...evidence,
      skillName: aggregate.name,
      createdAt: evidence.createdAt?.toISOString?.() ?? evidence.createdAt ?? null,
    };
    aggregate.evidence.push(fullEvidence);
    aggregate.sources.add(fullEvidence.type);
    allEvidence.push(fullEvidence);
  };

  user.skills.forEach((userSkill: any) => {
    const aggregate = ensureAggregate(userSkill.skill.name, {
      id: userSkill.skill.id,
      category: userSkill.skill.category,
      proficiency: userSkill.proficiency,
      yearsOfExp: userSkill.yearsOfExp,
    });
    if (aggregate) {
      addEvidence(aggregate.name, {
        id: `profile_skill:${userSkill.id}`,
        type: 'PROFILE_SKILL',
        title: `${aggregate.name} on profile`,
        subtitle: userSkill.proficiency || 'Self-declared skill',
        sourceUrl: null,
        verified: false,
        createdAt: userSkill.createdAt,
      });
    }
  });

  [...wantToLearn, ...canTeach, ...uniqueStrings(user.interests)].forEach((skill) => {
    ensureAggregate(skill);
  });

  user.projects.forEach((project: any) => {
    uniqueStrings(project.techStack).forEach((skill) => {
      addEvidence(skill, {
        id: `project:${project.id}:${skillKey(skill)}`,
        type: 'PROJECT',
        title: project.name,
        subtitle: project.featured ? 'Featured project' : project.role || 'Project evidence',
        sourceUrl: project.githubUrl || project.projectUrl || null,
        verified: Boolean(project.githubUrl),
        createdAt: project.updatedAt || project.createdAt,
      });
    });
  });

  user.experiences.forEach((experience: any) => {
    uniqueStrings(experience.skills).forEach((skill) => {
      addEvidence(skill, {
        id: `experience:${experience.id}:${skillKey(skill)}`,
        type: 'EXPERIENCE',
        title: experience.title,
        subtitle: experience.company,
        sourceUrl: null,
        verified: false,
        createdAt: experience.startDate || experience.createdAt,
      });
    });
  });

  user.certificates.forEach((certificate: any) => {
    const matchedSkills = Array.from(aggregates.values())
      .filter((skill: any) => evidenceMatchesSkill(certificate.name, skill.name))
      .map((skill: any) => skill.name);
    const skills = matchedSkills.length > 0 ? matchedSkills : uniqueStrings([certificate.name]);
    skills.forEach((skill) => {
      addEvidence(skill, {
        id: `certificate:${certificate.id}:${skillKey(skill)}`,
        type: 'CERTIFICATE',
        title: certificate.name,
        subtitle: certificate.issuingOrg,
        sourceUrl: certificate.credentialUrl || null,
        verified: Boolean(certificate.credentialUrl),
        createdAt: certificate.issueDate || certificate.createdAt,
      });
    });
  });

  user.achievements.forEach((achievement: any) => {
    const matchedSkills = Array.from(aggregates.values())
      .filter((skill: any) => (
        evidenceMatchesSkill(achievement.title, skill.name) ||
        evidenceMatchesSkill(achievement.description || '', skill.name)
      ))
      .map((skill: any) => skill.name);
    matchedSkills.slice(0, 3).forEach((skill) => {
      addEvidence(skill, {
        id: `achievement:${achievement.id}:${skillKey(skill)}`,
        type: 'ACHIEVEMENT',
        title: achievement.title,
        subtitle: achievement.organization || achievement.type,
        sourceUrl: achievement.certificateUrl || null,
        verified: Boolean(achievement.certificateUrl),
        createdAt: achievement.date || achievement.createdAt,
      });
    });
  });

  if (user.githubStats) {
    safeJsonArray(user.githubStats.topLanguages).forEach((language: any) => {
      const name = topLanguageName(language);
      if (!name) return;
      addEvidence(name, {
        id: `github_language:${skillKey(name)}`,
        type: 'GITHUB',
        title: `${name} activity`,
        subtitle: `${user.githubStats.totalPublicRepos || 0} public repos · ${user.githubStats.totalStars || 0} stars`,
        sourceUrl: user.githubProfileUrl,
        verified: true,
        createdAt: user.githubStats.lastCalculatedAt,
      });
    });

    safeJsonArray(user.githubStats.topRepos).slice(0, 6).forEach((repo: any) => {
      topRepoSkills(repo).forEach((skill) => {
        addEvidence(skill, {
          id: `github_repo:${repo?.name || repo?.url || Math.random()}:${skillKey(skill)}`,
          type: 'GITHUB_REPO',
          title: repo?.name || 'GitHub repository',
          subtitle: repo?.description || 'Repository signal',
          sourceUrl: repo?.url || repo?.html_url || user.githubProfileUrl,
          verified: true,
          createdAt: user.githubStats.lastCalculatedAt,
        });
      });
    });
  }

  verificationLinks.forEach((link) => {
    if (link.status !== 'verified') return;
    const provider = String(link.provider || '').toLowerCase();
    if (provider === 'leetcode') {
      ['Data Structures', 'Algorithms', 'Problem Solving'].forEach((skill) => {
        addEvidence(skill, {
          id: `verification_link:${link.id}:${skillKey(skill)}`,
          type: 'LEETCODE',
          title: `${link.username} on LeetCode`,
          subtitle: 'Linked coding profile',
          sourceUrl: link.profileUrl,
          verified: true,
          createdAt: link.verifiedAt || link.updatedAt || link.createdAt,
        });
      });
    } else if (provider === 'github' && !user.githubStats) {
      addEvidence('GitHub', {
        id: `verification_link:${link.id}:github`,
        type: 'GITHUB',
        title: `${link.username} on GitHub`,
        subtitle: 'Linked developer profile',
        sourceUrl: link.profileUrl,
        verified: true,
        createdAt: link.verifiedAt || link.updatedAt || link.createdAt,
      });
    } else {
      addEvidence(provider || 'Portfolio', {
        id: `verification_link:${link.id}:${provider || 'profile'}`,
        type: 'PROFILE_LINK',
        title: `${link.username} linked profile`,
        subtitle: provider ? `${provider} verification` : 'External verification',
        sourceUrl: link.profileUrl,
        verified: true,
        createdAt: link.verifiedAt || link.updatedAt || link.createdAt,
      });
    }
  });

  endorsements.forEach((endorsement) => {
    const aggregate = ensureAggregate(endorsement.skillName, { id: endorsement.skillId });
    if (!aggregate) return;
    aggregate.endorsements.push({
      id: endorsement.id,
      skillName: aggregate.name,
      note: endorsement.note,
      rating: endorsement.rating,
      source: endorsement.source,
      createdAt: endorsement.createdAt?.toISOString?.() ?? null,
      endorsedBy: formatUserCard(endorsement.endorsedBy),
    });
  });

  const skills = Array.from(aggregates.values()).map((skill: any) => {
    const evidenceCount = skill.evidence.length;
    const endorsementCount = skill.endorsements.length;
    const verifiedEvidenceCount = skill.evidence.filter((item: any) => item.verified).length;
    const confidenceScore = Math.min(
      100,
      12 + evidenceCount * 12 + verifiedEvidenceCount * 14 + endorsementCount * 16 +
        (skill.canTeach ? 8 : 0)
    );

    return {
      id: skill.id,
      name: skill.name,
      category: skill.category,
      proficiency: skill.proficiency,
      yearsOfExp: skill.yearsOfExp,
      canTeach: skill.canTeach,
      wantsToLearn: skill.wantsToLearn,
      evidenceCount,
      endorsementCount,
      verifiedEvidenceCount,
      confidenceScore,
      sources: Array.from(skill.sources),
      evidence: skill.evidence
        .sort((a: any, b: any) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'))
        .slice(0, 4),
      endorsements: skill.endorsements.slice(0, 3),
    };
  }).sort((a, b) => b.confidenceScore - a.confidenceScore || b.evidenceCount - a.evidenceCount);

  const verifiedSkills = skills.filter((skill) => skill.verifiedEvidenceCount > 0 || skill.endorsementCount > 0).length;
  const evidenceCount = allEvidence.length;
  const endorsementsCount = endorsements.length;
  const passportScore = Math.min(100, Math.round(
    skills.slice(0, 8).reduce((sum, skill) => sum + skill.confidenceScore, 0) / Math.max(1, Math.min(skills.length, 8))
  ));
  const topCategory = skills.find((skill) => skill.category)?.category || null;

  return {
    user: {
      ...formatUserCard(user),
      bio: user.bio,
      githubConnected: user.githubConnected,
      githubUsername: user.githubUsername,
      githubProfileUrl: user.githubProfileUrl,
    },
    summary: {
      totalSkills: skills.length,
      verifiedSkills,
      evidenceCount,
      endorsementsCount,
      passportScore,
      topCategory,
      verificationLinksCount: verificationLinks.length,
      hasVerifiedSkillsBadge: Boolean((accessSnapshot?.isPremium || accessSnapshot?.user?.isAdmin) && verifiedSkills > 0),
      isPremium: Boolean(accessSnapshot?.isPremium || accessSnapshot?.user?.isAdmin),
    },
    learningGoals: wantToLearn,
    teachingSkills: canTeach,
    skills,
    recentEvidence: allEvidence
      .sort((a, b) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'))
      .slice(0, 12),
    recentEndorsements: endorsements.slice(0, 8).map((endorsement) => ({
      id: endorsement.id,
      skillName: endorsement.skillName,
      note: endorsement.note,
      rating: endorsement.rating,
      source: endorsement.source,
      createdAt: endorsement.createdAt?.toISOString?.() ?? null,
      endorsedBy: formatUserCard(endorsement.endorsedBy),
    })),
    verificationLinks: verificationLinks.map((link) => ({
      id: link.id,
      provider: link.provider,
      username: link.username,
      profileUrl: link.profileUrl,
      status: link.status,
      verifiedAt: link.verifiedAt?.toISOString?.() ?? null,
      createdAt: link.createdAt?.toISOString?.() ?? null,
      updatedAt: link.updatedAt?.toISOString?.() ?? null,
    })),
  };
}

export const getSkillPassport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestingUserId = req.user?.userId ? String(req.user.userId) : null;
    const identifier = ensureString(req.params.userId) || 'me';
    const user = await resolveUser(identifier, requestingUserId);

    if (!user) {
      res.status(identifier === 'me' ? 401 : 404).json({
        error: identifier === 'me' ? 'Authentication required' : 'User not found',
      });
      return;
    }

    const [endorsements, verificationLinks, accessSnapshot] = await Promise.all([
      prisma.skillEndorsement.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 80,
      }),
      prisma.skillVerificationLink.findMany({
        where: { userId: user.id },
        orderBy: { updatedAt: 'desc' },
      }),
      getPremiumAccessSnapshot(user.id).catch(() => null),
    ]);
    const endorserIds = Array.from(new Set(endorsements.map((endorsement) => endorsement.endorsedById)));
    const endorsers = await prisma.user.findMany({
      where: { id: { in: endorserIds } },
      select: userCardSelect,
    });
    const endorserById = new Map(endorsers.map((user) => [user.id, user]));

    res.json(buildPassport(
      user,
      endorsements.map((endorsement) => ({
        ...endorsement,
        endorsedBy: endorserById.get(endorsement.endorsedById),
      })),
      verificationLinks,
      accessSnapshot
    ));
  } catch (error) {
    console.error('Error building skill passport:', error);
    res.status(500).json({ error: 'Failed to build skill passport' });
  }
};

async function areConnected(leftUserId: string, rightUserId: string): Promise<boolean> {
  const connection = await prisma.connections.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: leftUserId, addresseeId: rightUserId },
        { requesterId: rightUserId, addresseeId: leftUserId },
      ],
    },
    select: { id: true },
  });
  return Boolean(connection);
}

function normalizeProvider(value: unknown): string {
  const provider = ensureString(value).toLowerCase();
  if (['github', 'leetcode', 'portfolio'].includes(provider)) return provider;
  return '';
}

function providerProfileUrl(provider: string, username: string, profileUrl?: string | null): string | null {
  if (profileUrl) return profileUrl;
  if (provider === 'github') return `https://github.com/${encodeURIComponent(username)}`;
  if (provider === 'leetcode') return `https://leetcode.com/${encodeURIComponent(username)}/`;
  return null;
}

export const endorseSkill = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const endorserId = req.user?.userId ? String(req.user.userId) : null;
    if (!endorserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const targetUserId = ensureString(req.params.userId);
    const skillName = normalizeSkillName(req.body.skillName);
    const note = ensureString(req.body.note).slice(0, 240) || null;
    const rating = req.body.rating === undefined
      ? null
      : Math.min(5, Math.max(1, Number(req.body.rating) || 5));

    if (!targetUserId || !skillName) {
      res.status(400).json({ error: 'Target user and skillName are required' });
      return;
    }
    if (targetUserId === endorserId) {
      res.status(400).json({ error: 'You cannot endorse yourself' });
      return;
    }

    const [target, endorser, connected] = await Promise.all([
      prisma.user.findFirst({ where: { id: targetUserId, isBanned: false }, select: userCardSelect }),
      prisma.user.findUnique({ where: { id: endorserId }, select: userCardSelect }),
      areConnected(endorserId, targetUserId),
    ]);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!connected) {
      res.status(403).json({
        error: 'You can endorse skills only for connected users.',
        code: 'connection_required_for_endorsement',
      });
      return;
    }

    const skill = await findOrCreateSkill(skillName);
    const existing = await prisma.skillEndorsement.findFirst({
      where: {
        userId: targetUserId,
        endorsedById: endorserId,
        skillName: { equals: skill.name, mode: 'insensitive' },
        source: 'manual',
      },
    });

    const endorsement = existing
      ? await prisma.skillEndorsement.update({
          where: { id: existing.id },
          data: { note, rating, skillId: skill.id, skillName: skill.name },
        })
      : await prisma.skillEndorsement.create({
          data: {
            userId: targetUserId,
            endorsedById: endorserId,
            skillId: skill.id,
            skillName: skill.name,
            source: 'manual',
            note,
            rating,
          },
        });

    await prisma.userSkill.upsert({
      where: { userId_skillId: { userId: targetUserId, skillId: skill.id } },
      create: { userId: targetUserId, skillId: skill.id, proficiency: null, yearsOfExp: null },
      update: {},
    }).catch(() => null);

    notificationService.notifySkillEndorsement(targetUserId, endorserId, {
      endorserName: endorser?.name || 'Someone',
      skillName: skill.name,
      endorsementId: endorsement.id,
    }).catch(console.error);

    res.status(existing ? 200 : 201).json({
      endorsement: {
        id: endorsement.id,
        skillName: endorsement.skillName,
        note: endorsement.note,
        rating: endorsement.rating,
        source: endorsement.source,
        createdAt: endorsement.createdAt?.toISOString?.() ?? null,
        endorsedBy: formatUserCard(endorser),
      },
    });
  } catch (error) {
    console.error('Error endorsing skill:', error);
    res.status(500).json({ error: 'Failed to endorse skill' });
  }
};

export const upsertSkillVerificationLink = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const provider = normalizeProvider(req.body.provider);
    const username = normalizeSkillName(req.body.username);
    const rawProfileUrl = ensureString(req.body.profileUrl).slice(0, 500) || null;
    if (!provider || !username) {
      res.status(400).json({ error: 'provider must be github, leetcode, or portfolio, and username is required' });
      return;
    }

    const profileUrl = providerProfileUrl(provider, username, rawProfileUrl);
    const link = await prisma.skillVerificationLink.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        username,
        profileUrl,
        status: 'verified',
        verifiedAt: new Date(),
        metadata: {
          autoVerified: true,
          source: 'profile_link',
        },
      },
      update: {
        username,
        profileUrl,
        status: 'verified',
        verifiedAt: new Date(),
        metadata: {
          autoVerified: true,
          source: 'profile_link',
        },
      },
    });

    if (provider === 'github') {
      await prisma.user.update({
        where: { id: userId },
        data: {
          githubConnected: true,
          githubUsername: username,
          githubProfileUrl: profileUrl,
        },
      }).catch(() => null);
    }

    res.json({
      verificationLink: {
        id: link.id,
        provider: link.provider,
        username: link.username,
        profileUrl: link.profileUrl,
        status: link.status,
        verifiedAt: link.verifiedAt?.toISOString?.() ?? null,
        createdAt: link.createdAt.toISOString(),
        updatedAt: link.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Error upserting skill verification link:', error);
    res.status(500).json({ error: 'Failed to link skill verification profile' });
  }
};

export const deleteSkillVerificationLink = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const provider = normalizeProvider(req.params.provider);
    if (!provider) {
      res.status(400).json({ error: 'Invalid provider' });
      return;
    }

    await prisma.skillVerificationLink.deleteMany({ where: { userId, provider } });
    res.json({ deleted: true });
  } catch (error) {
    console.error('Error deleting skill verification link:', error);
    res.status(500).json({ error: 'Failed to delete skill verification profile' });
  }
};

async function getCurrentSkillProfile(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      college: true,
      branch: true,
      interests: true,
      user_onboarding: {
        select: { wantToLearn: true, canTeach: true, primaryGoal: true, lookingFor: true },
      },
      skills: { select: { skill: { select: { name: true } } } },
    },
  });
}

export const getSkillSwapSuggestions = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const mode = ensureString(req.query.mode) === 'teach' ? 'teach' : 'learn';
    const requestedSkill = normalizeSkillName(req.query.skill);
    const currentUser = await getCurrentSkillProfile(userId);
    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const myWantToLearn = uniqueStrings(currentUser.user_onboarding?.wantToLearn);
    const myCanTeach = uniqueStrings(currentUser.user_onboarding?.canTeach);
    const targetSkills = requestedSkill
      ? [requestedSkill]
      : mode === 'teach'
        ? myCanTeach
        : myWantToLearn;
    const fallbackSkills = uniqueStrings([
      ...targetSkills,
      ...myWantToLearn,
      ...myCanTeach,
      ...currentUser.interests,
    ]).slice(0, 8);

    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
        isBanned: false,
      },
      orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
      take: 150,
      select: {
        ...userCardSelect,
        interests: true,
        user_onboarding: { select: { wantToLearn: true, canTeach: true, primaryGoal: true } },
        skills: { select: { skill: { select: { name: true } } } },
        projects: { select: { techStack: true }, take: 8 },
        certificates: { select: { name: true }, take: 8 },
      },
    });

    const pendingRequests = await prisma.skillSwapRequest.findMany({
      where: {
        status: 'pending',
        OR: [{ requesterId: userId }, { recipientId: userId }],
      },
      select: { requesterId: true, recipientId: true, skill: true, status: true },
    });

    const activeRequestStatus = (candidateId: string, skill: string) => {
      const key = skillKey(skill);
      return pendingRequests.find((request) =>
        ((request.requesterId === userId && request.recipientId === candidateId) ||
          (request.requesterId === candidateId && request.recipientId === userId)) &&
        skillKey(request.skill) === key
      )?.status || null;
    };

    const suggestions = users.flatMap((user: any) => {
      const candidateCanTeach = uniqueStrings([
        ...uniqueStrings(user.user_onboarding?.canTeach),
        ...user.skills.map((item: any) => item.skill.name),
      ]);
      const candidateWantsToLearn = uniqueStrings(user.user_onboarding?.wantToLearn);
      const candidateEvidence = uniqueStrings([
        ...candidateCanTeach,
        ...user.projects.flatMap((project: any) => uniqueStrings(project.techStack)),
        ...user.certificates.map((certificate: any) => certificate.name),
      ]);
      const skillsToMatch = targetSkills.length > 0 ? targetSkills : fallbackSkills;
      const matchedSkills = skillsToMatch.filter((skill) => {
        if (mode === 'teach') {
          return overlaps([skill], candidateWantsToLearn);
        }
        return overlaps([skill], candidateCanTeach) || overlaps([skill], candidateEvidence);
      });

      if (matchedSkills.length === 0) return [];

      return matchedSkills.slice(0, 2).map((skill) => {
        const sameCampus = Boolean(currentUser.college && user.college === currentUser.college);
        const sameBranch = Boolean(currentUser.branch && user.branch === currentUser.branch);
        const evidenceCount = candidateEvidence.filter((item) => evidenceMatchesSkill(item, skill)).length;
        const matchScore = Math.min(100, 46 + evidenceCount * 9 + (sameCampus ? 12 : 0) + (sameBranch ? 8 : 0));
        return {
          user: formatUserCard(user),
          skill,
          mode,
          direction: mode === 'teach' ? 'teach_to' : 'learn_from',
          matchScore,
          evidenceCount,
          matchReason: mode === 'teach'
            ? `${user.name} wants help with ${skill}`
            : `${user.name} can help you learn ${skill}`,
          sharedContext: {
            sameCampus,
            sameBranch,
            college: sameCampus ? user.college : null,
          },
          activeRequestStatus: activeRequestStatus(user.id, skill),
        };
      });
    })
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 30);

    res.json({
      mode,
      featuredSkills: fallbackSkills,
      suggestions,
    });
  } catch (error) {
    console.error('Error fetching skill swap suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch skill swap suggestions' });
  }
};

async function hydrateSkillSwapRows(rows: any[], sessions: any[] = []) {
  const userIds = Array.from(new Set(rows.flatMap((row) => [row.requesterId, row.recipientId])));
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: userCardSelect,
  });
  const userById = new Map(users.map((user) => [user.id, user]));
  const sessionByRequestId = new Map(sessions.map((session) => [session.requestId, session]));

  return rows.map((row) => ({
    id: row.id,
    skill: row.skill,
    message: row.message,
    requesterGoal: row.requesterGoal,
    mode: row.mode,
    status: row.status,
    sessionLengthMinutes: row.sessionLengthMinutes,
    scheduledFor: row.scheduledFor?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null,
    respondedAt: row.respondedAt?.toISOString?.() ?? null,
    requester: formatUserCard(userById.get(row.requesterId)),
    recipient: formatUserCard(userById.get(row.recipientId)),
    session: sessionByRequestId.has(row.id) ? formatSession(sessionByRequestId.get(row.id), userById) : null,
  }));
}

function formatSession(session: any, userById?: Map<string, any>) {
  return {
    id: session.id,
    requestId: session.requestId,
    skill: session.skill,
    status: session.status,
    sessionLengthMinutes: session.sessionLengthMinutes,
    scheduledFor: session.scheduledFor?.toISOString?.() ?? null,
    completedAt: session.completedAt?.toISOString?.() ?? null,
    learnerRating: session.learnerRating,
    mentorRating: session.mentorRating,
    learnerNote: session.learnerNote,
    mentorNote: session.mentorNote,
    createdAt: session.createdAt?.toISOString?.() ?? null,
    mentor: userById ? formatUserCard(userById.get(session.mentorId)) : null,
    learner: userById ? formatUserCard(userById.get(session.learnerId)) : null,
  };
}

export const getSkillSwapState = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [requests, sessions] = await Promise.all([
      prisma.skillSwapRequest.findMany({
        where: { OR: [{ requesterId: userId }, { recipientId: userId }] },
        orderBy: { createdAt: 'desc' },
        take: 80,
      }),
      prisma.skillSwapSession.findMany({
        where: { OR: [{ mentorId: userId }, { learnerId: userId }] },
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        take: 60,
      }),
    ]);

    const hydratedRequests = await hydrateSkillSwapRows(requests, sessions);
    const userIds = Array.from(new Set(sessions.flatMap((session) => [session.mentorId, session.learnerId])));
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: userCardSelect,
    });
    const userById = new Map(users.map((user) => [user.id, user]));

    res.json({
      incoming: hydratedRequests.filter((request) => request.recipient?.id === userId && request.status === 'pending'),
      outgoing: hydratedRequests.filter((request) => request.requester?.id === userId && request.status === 'pending'),
      history: hydratedRequests.filter((request) => request.status !== 'pending').slice(0, 20),
      sessions: sessions.map((session) => formatSession(session, userById)),
    });
  } catch (error) {
    console.error('Error fetching skill swap state:', error);
    res.status(500).json({ error: 'Failed to fetch skill swap state' });
  }
};

export const createSkillSwapRequest = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const requesterId = req.user?.userId ? String(req.user.userId) : null;
    if (!requesterId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const recipientId = ensureString(req.body.recipientId);
    const skill = normalizeSkillName(req.body.skill);
    const message = ensureString(req.body.message).slice(0, 280) || null;
    const requesterGoal = ensureString(req.body.requesterGoal).slice(0, 140) || null;
    const mode = ensureString(req.body.mode) === 'teach' ? 'teach' : 'learn';
    const sessionLengthMinutes = Math.min(
      90,
      Math.max(15, Number(req.body.sessionLengthMinutes) || DEFAULT_SESSION_LENGTH)
    );
    const scheduledForRaw = ensureString(req.body.scheduledFor);
    const scheduledFor = scheduledForRaw ? new Date(scheduledForRaw) : null;

    if (!recipientId || !skill) {
      res.status(400).json({ error: 'Recipient and skill are required' });
      return;
    }
    if (recipientId === requesterId) {
      res.status(400).json({ error: 'You cannot request a swap with yourself' });
      return;
    }

    const [requester, recipient] = await Promise.all([
      prisma.user.findFirst({
        where: { id: requesterId, isBanned: false },
        select: { id: true, username: true, name: true },
      }),
      prisma.user.findFirst({
        where: { id: recipientId, isBanned: false },
        select: { id: true, username: true, name: true },
      }),
    ]);
    if (!recipient) {
      res.status(404).json({ error: 'Recipient not found' });
      return;
    }

    const existing = await prisma.skillSwapRequest.findFirst({
      where: {
        requesterId,
        recipientId,
        status: 'pending',
        skill: { equals: skill, mode: 'insensitive' },
      },
    });
    if (existing) {
      res.status(409).json({ error: 'A pending request already exists for this skill' });
      return;
    }

    const request = await prisma.skillSwapRequest.create({
      data: {
        requesterId,
        recipientId,
        skill,
        message,
        requesterGoal,
        mode,
        sessionLengthMinutes,
        scheduledFor: scheduledFor && !Number.isNaN(scheduledFor.getTime()) ? scheduledFor : null,
      },
    });

    const [hydrated] = await hydrateSkillSwapRows([request]);
    notificationService.notifySkillSwapRequest(recipientId, requesterId, {
      requesterName: skillSwapDisplayName(requester, 'A student'),
      requestId: request.id,
      skillName: request.skill,
      mode: request.mode,
      sessionLengthMinutes: request.sessionLengthMinutes,
    }).catch(() => undefined);
    res.status(201).json({ request: hydrated });
  } catch (error) {
    console.error('Error creating skill swap request:', error);
    res.status(500).json({ error: 'Failed to create skill swap request' });
  }
};

export const respondToSkillSwapRequest = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const requestId = ensureString(req.params.requestId);
    const action = ensureString(req.body.action).toLowerCase();
    if (!['accept', 'decline'].includes(action)) {
      res.status(400).json({ error: 'Action must be accept or decline' });
      return;
    }

    const request = await prisma.skillSwapRequest.findFirst({
      where: { id: requestId, recipientId: userId, status: 'pending' },
    });
    if (!request) {
      res.status(404).json({ error: 'Pending request not found' });
      return;
    }

    if (action === 'decline') {
      const updated = await prisma.skillSwapRequest.update({
        where: { id: request.id },
        data: { status: 'declined', respondedAt: new Date() },
      });
      const [hydrated] = await hydrateSkillSwapRows([updated]);
      res.json({ request: hydrated });
      return;
    }

    const mentorId = request.mode === 'teach' ? request.requesterId : request.recipientId;
    const learnerId = request.mode === 'teach' ? request.recipientId : request.requesterId;
    const [updated, session] = await prisma.$transaction(async (tx) => {
      const accepted = await tx.skillSwapRequest.update({
        where: { id: request.id },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      const createdSession = await tx.skillSwapSession.create({
        data: {
          requestId: request.id,
          mentorId,
          learnerId,
          skill: request.skill,
          sessionLengthMinutes: request.sessionLengthMinutes,
          scheduledFor: request.scheduledFor,
        },
      });
      return [accepted, createdSession];
    });

    const [hydrated] = await hydrateSkillSwapRows([updated], [session]);
    notificationService.notifySkillSwapAccepted(request.requesterId, userId, {
      accepterName: skillSwapDisplayName(hydrated.recipient, 'A student'),
      requestId: request.id,
      sessionId: session.id,
      skillName: request.skill,
      sessionLengthMinutes: request.sessionLengthMinutes,
    }).catch(() => undefined);
    res.json({ request: hydrated, session: hydrated.session });
  } catch (error) {
    console.error('Error responding to skill swap request:', error);
    res.status(500).json({ error: 'Failed to respond to skill swap request' });
  }
};

export const completeSkillSwapSession = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sessionId = ensureString(req.params.sessionId);
    const rating = Math.min(5, Math.max(1, Number(req.body.rating) || 5));
    const note = ensureString(req.body.note).slice(0, 240) || null;
    const endorseSkill = req.body.endorseSkill !== false;

    const session = await prisma.skillSwapSession.findFirst({
      where: {
        id: sessionId,
        OR: [{ mentorId: userId }, { learnerId: userId }],
      },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const isLearner = session.learnerId === userId;
    const endorsedUserId = isLearner ? session.mentorId : session.learnerId;
    const data = {
      status: 'completed',
      completedAt: session.completedAt || new Date(),
      ...(isLearner
        ? { learnerRating: rating, learnerNote: note }
        : { mentorRating: rating, mentorNote: note }),
    };

    const updated = await prisma.skillSwapSession.update({
      where: { id: session.id },
      data,
    });

    let endorsement = null;
    if (endorseSkill) {
      const skill = await findOrCreateSkill(session.skill);
      const existing = await prisma.skillEndorsement.findFirst({
        where: {
          userId: endorsedUserId,
          endorsedById: userId,
          source: 'skill_swap',
          sourceId: session.id,
        },
      });
      endorsement = existing || await prisma.skillEndorsement.create({
        data: {
          userId: endorsedUserId,
          endorsedById: userId,
          skillId: skill.id,
          skillName: skill.name,
          source: 'skill_swap',
          sourceId: session.id,
          note,
          rating,
        },
      });
    }

    const users = await prisma.user.findMany({
      where: { id: { in: [updated.mentorId, updated.learnerId] } },
      select: userCardSelect,
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    notificationService.notifySkillSwapCompleted(endorsedUserId, userId, {
      actorName: skillSwapDisplayName(userById.get(userId), 'A student'),
      sessionId: updated.id,
      requestId: updated.requestId,
      skillName: updated.skill,
    }).catch(() => undefined);
    res.json({
      session: formatSession(updated, userById),
      endorsement,
    });
  } catch (error) {
    console.error('Error completing skill swap session:', error);
    res.status(500).json({ error: 'Failed to complete skill swap session' });
  }
};
