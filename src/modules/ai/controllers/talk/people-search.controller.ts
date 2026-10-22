import { discoverableUsersWhere } from "../../../safety/services/safety-policy";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { PEOPLE_INTENT_PATTERNS, STOP_WORDS, TECH_TERMS, MAX_DB_SEARCH_TERMS, compactList, RelationshipSummary, TalkPersonCard, toComparableSet, normalizeComparable, reasonPush, buildConnectReason, MAX_PEOPLE_SEARCH_POOL, getRelationshipSummary, MAX_AI_CANDIDATES } from "./support.controller";

export const titleCaseSearchValue = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');

export const interestSearchVariants = (value: string): string[] =>
  Array.from(new Set([value, value.toLowerCase(), titleCaseSearchValue(value)].filter(Boolean)));

export const shouldSearchPeople = (message: string): boolean =>
  PEOPLE_INTENT_PATTERNS.some((pattern) => pattern.test(message));

export const extractSearchTerms = (message: string): string[] => {
  const lower = message.toLowerCase();
  const rawWords = lower
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  const terms = new Set<string>();
  const mentionsTech =
    /\b(tech|technology|coding|code|programming|software|developer|engineer|ai|ml|startup|builder)\b/i.test(
      message
    );

  for (const word of rawWords) {
    terms.add(word);
  }

  if (mentionsTech) {
    TECH_TERMS.forEach((term) => terms.add(term));
  }

  return Array.from(terms).slice(0, MAX_DB_SEARCH_TERMS);
};

export const buildPeopleWhere = (
  userId: string,
  terms: string[],
  currentUser: any,
  blockedUserIds: string[] = []
): any => {
  const searchTerms = terms.length > 0
    ? terms
    : [
        ...compactList(currentUser?.interests),
        ...compactList(currentUser?.user_onboarding?.wantToLearn),
        ...compactList(currentUser?.user_onboarding?.lookingFor),
      ].slice(0, MAX_DB_SEARCH_TERMS);

  const orClauses: any[] = [];
  const interestVariants = Array.from(new Set(searchTerms.flatMap(interestSearchVariants)));

  for (const term of searchTerms) {
    orClauses.push(
      { name: { contains: term, mode: 'insensitive' } },
      { username: { contains: term, mode: 'insensitive' } },
      { headline: { contains: term, mode: 'insensitive' } },
      { bio: { contains: term, mode: 'insensitive' } },
      { college: { contains: term, mode: 'insensitive' } },
      { branch: { contains: term, mode: 'insensitive' } },
      {
        skills: {
          some: {
            skill: {
              name: { contains: term, mode: 'insensitive' },
            },
          },
        },
      }
    );
  }

  if (interestVariants.length > 0) {
    orClauses.push({ interests: { hasSome: interestVariants } });
  }

  // Shared discovery policy: not self, banned, blocked or currently suspended.
  // Its suspension OR is moved into AND so it cannot collide with the search OR.
  const { OR: suspensionOr, ...discoverable } = discoverableUsersWhere(userId, blockedUserIds);
  const where: any = {
    ...discoverable,
    AND: [{ OR: suspensionOr }],
  };

  if (orClauses.length > 0) {
    where.OR = orClauses;
  }

  return where;
};

export const scoreCandidate = (
  user: any,
  currentUser: any,
  terms: string[],
  relationship: RelationshipSummary
): TalkPersonCard => {
  const skills: string[] = user.skills?.map((item: any) => item.skill.name).filter(Boolean) || [];
  const interests = compactList(user.interests);
  const skillSet = toComparableSet(skills);
  const interestSet = toComparableSet(interests);
  const currentSkills = toComparableSet(
    currentUser?.skills?.map((item: any) => item.skill.name).filter(Boolean) || []
  );
  const currentInterests = toComparableSet(compactList(currentUser?.interests));
  const searchableText = [
    user.name,
    user.username,
    user.headline,
    user.bio,
    user.college,
    user.branch,
    ...skills,
    ...interests,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const reasons: string[] = [];
  let score = 8;

  for (const term of terms) {
    const normalizedTerm = normalizeComparable(term);
    if (skillSet.has(normalizedTerm) || skills.some((skill) => normalizeComparable(skill).includes(normalizedTerm))) {
      score += 18;
      reasonPush(reasons, `Knows ${titleCaseSearchValue(term)}`);
    } else if (interestSet.has(normalizedTerm)) {
      score += 9;
      reasonPush(reasons, `Interested in ${titleCaseSearchValue(term)}`);
    } else if (searchableText.includes(normalizedTerm)) {
      score += 5;
      reasonPush(reasons, `Profile mentions ${titleCaseSearchValue(term)}`);
    }
  }

  const sharedSkills = skills.filter((skill) => currentSkills.has(normalizeComparable(skill))).length;
  if (sharedSkills > 0) {
    score += Math.min(sharedSkills * 8, 24);
    reasonPush(reasons, `${sharedSkills} shared skill${sharedSkills === 1 ? '' : 's'}`);
  }

  const sharedInterests = interests.filter((interest) =>
    currentInterests.has(normalizeComparable(interest))
  ).length;
  if (sharedInterests > 0) {
    score += Math.min(sharedInterests * 6, 18);
    reasonPush(reasons, `${sharedInterests} shared interest${sharedInterests === 1 ? '' : 's'}`);
  }

  if (currentUser?.college && user.college && currentUser.college === user.college) {
    score += 12;
    reasonPush(reasons, 'Same college');
  }

  if (currentUser?.branch && user.branch && currentUser.branch === user.branch) {
    score += 8;
    reasonPush(reasons, 'Same branch');
  }

  const currentOnboarding = currentUser?.user_onboarding;
  const targetOnboarding = user.user_onboarding;
  if (
    currentOnboarding?.primaryGoal &&
    targetOnboarding?.primaryGoal &&
    currentOnboarding.primaryGoal === targetOnboarding.primaryGoal
  ) {
    score += 10;
    reasonPush(reasons, 'Similar goal');
  }

  const canTeach = toComparableSet(compactList(targetOnboarding?.canTeach));
  const wantToLearn = compactList(currentOnboarding?.wantToLearn);
  if (wantToLearn.some((item) => canTeach.has(normalizeComparable(item)))) {
    score += 14;
    reasonPush(reasons, 'Can help with something you want to learn');
  }

  const isRecentlyActive =
    user.lastActiveAt && new Date(user.lastActiveAt).getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (isRecentlyActive) {
    score += 5;
    reasonPush(reasons, 'Recently active');
  }

  if (user.isOpenToOpportunities) {
    score += 4;
    reasonPush(reasons, 'Open to opportunities');
  }

  const connectionStatus = relationship.connectionStatusByUser.get(user.id) || 'none';
  if (connectionStatus === 'none') {
    score += 6;
  } else if (connectionStatus === 'connected') {
    score -= 12;
  } else {
    score -= 20;
  }

  if (reasons.length === 0) {
    reasonPush(reasons, 'Good overall profile fit');
  }

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    profileImage: user.profileImage,
    bannerImageUrl: user.bannerImageUrl,
    headline: user.headline,
    college: user.college,
    branch: user.branch,
    bio: user.bio,
    skills,
    interests,
    isOnline: Boolean(user.isOnline),
    connectionStatus,
    mutualConnections: relationship.mutualConnectionsByUser.get(user.id) || 0,
    matchScore: Math.max(1, Math.min(98, Math.round(score))),
    reasons,
    connectReason: buildConnectReason(user, reasons),
  };
};

export const findRecommendedPeople = async (
  userId: string,
  terms: string[],
  currentUser: any
): Promise<TalkPersonCard[]> => {
  const blockedUserIds = await getBlockedUserIds(userId);
  const users = await prisma.user.findMany({
    where: buildPeopleWhere(userId, terms, currentUser, blockedUserIds),
    take: MAX_PEOPLE_SEARCH_POOL,
    orderBy: [{ lastActiveAt: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      username: true,
      name: true,
      profileImage: true,
      bannerImageUrl: true,
      headline: true,
      college: true,
      branch: true,
      bio: true,
      interests: true,
      isOnline: true,
      isOpenToOpportunities: true,
      lastActiveAt: true,
      skills: { select: { skill: { select: { name: true } } } },
      user_onboarding: {
        select: {
          primaryGoal: true,
          wantToLearn: true,
          canTeach: true,
          lookingFor: true,
        },
      },
    },
  });

  const relationship = await getRelationshipSummary(
    userId,
    users.map((user) => user.id)
  );

  return users
    .map((user) => scoreCandidate(user, currentUser, terms, relationship))
    .sort((a, b) => b.matchScore - a.matchScore || b.mutualConnections - a.mutualConnections)
    .slice(0, MAX_AI_CANDIDATES);
};
