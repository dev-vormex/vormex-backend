import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { discoverableUsersWhere } from "../../../safety/services/safety-policy";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { normalizeSkillName, getCurrentSkillProfile, uniqueStrings, userCardSelect, skillKey, overlaps, evidenceMatchesSkill, formatUserCard, hydrateSkillSwapRows, formatSession } from "./support.controller";

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
      where: discoverableUsersWhere(userId, await getBlockedUserIds(userId)),
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
