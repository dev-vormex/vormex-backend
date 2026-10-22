import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { assertCanViewUser, getBlockedUserIds, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { getPremiumAccessSnapshot } from "../../../premium/services/premium-access.service";
import { uniqueStrings, normalizeSkillName, skillKey, evidenceMatchesSkill, safeJsonArray, topLanguageName, topRepoSkills, formatUserCard, resolveUser, userCardSelect } from "./support.controller";

export function buildPassport(user: any, endorsements: any[], verificationLinks: any[] = [], accessSnapshot?: any) {
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

    // Viewing someone else's passport: blocked/banned/suspended owners are hidden (404).
    const viewerIsOwner = !requestingUserId || requestingUserId === user.id;
    if (requestingUserId && !viewerIsOwner) {
      await assertCanViewUser(requestingUserId, user.id);
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
    // Third-party viewers do not see endorsements from users they have blocked / who blocked them.
    const hiddenEndorserIds = requestingUserId && !viewerIsOwner
      ? new Set(await getBlockedUserIds(requestingUserId))
      : new Set<string>();
    const visibleEndorsements = hiddenEndorserIds.size > 0
      ? endorsements.filter((endorsement) => !hiddenEndorserIds.has(endorsement.endorsedById))
      : endorsements;
    const endorserIds = Array.from(new Set(visibleEndorsements.map((endorsement) => endorsement.endorsedById)));
    const endorsers = await prisma.user.findMany({
      where: { id: { in: endorserIds } },
      select: userCardSelect,
    });
    const endorserById = new Map(endorsers.map((user) => [user.id, user]));

    res.json(buildPassport(
      user,
      visibleEndorsements.map((endorsement) => ({
        ...endorsement,
        endorsedBy: endorserById.get(endorsement.endorsedById),
      })),
      verificationLinks,
      accessSnapshot
    ));
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('Error building skill passport:', error);
    res.status(500).json({ error: 'Failed to build skill passport' });
  }
};
