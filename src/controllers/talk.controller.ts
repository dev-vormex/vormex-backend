import { randomUUID } from 'crypto';
import { Response } from 'express';
import { prisma } from '../config/prisma';
import { getRequestId, getRequestLogger } from '../lib/logger';
import { aiService } from '../services/ai.service';
import { cacheService } from '../services/cache.service';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { sanitizeStringInput } from '../utils/input-security.util';
import { isUUID } from '../utils/username.util';

type TalkRole = 'user' | 'assistant';
type TalkMode = 'people_discovery' | 'general';
type ConnectionStatus = 'none' | 'pending_sent' | 'pending_received' | 'connected';

interface TalkHistoryItem {
  role: TalkRole;
  content: string;
}

interface TalkTurnResponse {
  answer: string;
  costMode: 'retrieval_first';
  followUpQuestions: string[];
  mode: TalkMode;
  people: TalkPersonCard[];
  peopleTitle?: string;
}

interface TalkPersonCard {
  id: string;
  username: string;
  name: string;
  profileImage: string | null;
  bannerImageUrl: string | null;
  headline: string | null;
  college: string | null;
  branch: string | null;
  bio: string | null;
  skills: string[];
  interests: string[];
  isOnline: boolean;
  connectionStatus: ConnectionStatus;
  mutualConnections: number;
  matchScore: number;
  reasons: string[];
  connectReason: string;
}

interface RelationshipSummary {
  connectionStatusByUser: Map<string, ConnectionStatus>;
  mutualConnectionsByUser: Map<string, number>;
}

const TALK_ACCEPTED_CONNECTION_CACHE_TTL_SECONDS = 30;
const TALK_CURRENT_USER_CONTEXT_CACHE_TTL_SECONDS = 2 * 60;
const TALK_PROFILE_PREVIEW_CACHE_TTL_SECONDS = 5 * 60;
const MAX_HISTORY_ITEMS = 8;
const MAX_DB_SEARCH_TERMS = 10;
const MAX_AI_CANDIDATES = 6;
const MAX_PEOPLE_SEARCH_POOL = 36;
const MAX_MUTUAL_CONNECTION_SCAN_IDS = 500;

const TECH_TERMS = [
  'technology',
  'software',
  'developer',
  'programming',
  'coding',
  'python',
  'javascript',
  'typescript',
  'react',
  'node',
  'backend',
  'frontend',
  'full stack',
  'android',
  'kotlin',
  'ai',
  'ml',
  'machine learning',
  'data science',
  'cloud',
  'devops',
];

const STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'can',
  'find',
  'for',
  'give',
  'has',
  'have',
  'help',
  'i',
  'in',
  'is',
  'know',
  'knows',
  'like',
  'me',
  'need',
  'of',
  'on',
  'one',
  'people',
  'person',
  'recommend',
  'recommended',
  'show',
  'someone',
  'that',
  'the',
  'to',
  'want',
  'who',
  'with',
]);

const PEOPLE_INTENT_PATTERNS = [
  /\b(find|show|recommend|suggest|match|connect|meet|mentor|teammate|partner|people|person|someone|who knows|knows)\b/i,
  /\b(learn from|build with|team up|collaborate|hire|follow)\b/i,
];

const normalizeText = (value: unknown, maxLength = 1200, allowEmpty = false): string => {
  if (typeof value !== 'string') {
    return '';
  }

  const sanitized = sanitizeStringInput(value, {
    allowEmpty,
    maxLength,
  });

  return sanitized.ok ? sanitized.value || '' : '';
};

const titleCaseSearchValue = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');

const interestSearchVariants = (value: string): string[] =>
  Array.from(new Set([value, value.toLowerCase(), titleCaseSearchValue(value)].filter(Boolean)));

const compactList = (values: unknown): string[] => {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .slice(0, 12);
};

const normalizeComparable = (value: string): string => value.trim().toLowerCase();

const toComparableSet = (values: string[]): Set<string> => new Set(values.map(normalizeComparable));

const shouldSearchPeople = (message: string): boolean =>
  PEOPLE_INTENT_PATTERNS.some((pattern) => pattern.test(message));

const extractSearchTerms = (message: string): string[] => {
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

const getAcceptedConnectionIdsCacheKey = (userId: string): string =>
  `talk:accepted-connections:${userId}`;

const getCurrentUserContextCacheKey = (userId: string): string =>
  `talk:current-user-context:v1:${userId}`;

const getProfilePreviewCacheKey = (userId: string): string =>
  `talk:profile-preview:v1:${userId}`;

const getProfilePreviewLookupCacheKey = (identifier: string): string =>
  `talk:profile-preview-lookup:v1:${identifier.toLowerCase()}`;

const getAcceptedConnectionIds = async (userId: string): Promise<string[]> => {
  const cacheKey = getAcceptedConnectionIdsCacheKey(userId);
  const cached = await cacheService.get<string[]>(cacheKey);
  if (cached) return cached;

  const currentUserConnections = await prisma.connections.findMany({
    where: {
      status: 'accepted',
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    orderBy: { updatedAt: 'desc' },
    take: MAX_MUTUAL_CONNECTION_SCAN_IDS,
    select: { requesterId: true, addresseeId: true },
  });

  const ids = Array.from(
    new Set(
      currentUserConnections.map((connection) =>
        connection.requesterId === userId ? connection.addresseeId : connection.requesterId
      )
    )
  );

  await cacheService.set(
    cacheKey,
    ids,
    TALK_ACCEPTED_CONNECTION_CACHE_TTL_SECONDS,
    [`people:connections:${userId}`]
  );

  return ids;
};

const getRelationshipSummary = async (
  currentUserId: string,
  targetIds: string[]
): Promise<RelationshipSummary> => {
  if (targetIds.length === 0) {
    return {
      connectionStatusByUser: new Map<string, ConnectionStatus>(),
      mutualConnectionsByUser: new Map<string, number>(),
    };
  }

  const uniqueTargetIds = Array.from(new Set(targetIds));
  const targetIdSet = new Set(uniqueTargetIds);
  const connectionStatusByUser = new Map<string, ConnectionStatus>();
  const mutualConnectionsByUser = new Map<string, number>();

  const [directConnections, currentConnectionIds] = await Promise.all([
    prisma.connections.findMany({
      where: {
        OR: [
          { requesterId: currentUserId, addresseeId: { in: uniqueTargetIds } },
          { requesterId: { in: uniqueTargetIds }, addresseeId: currentUserId },
        ],
      },
      select: { requesterId: true, addresseeId: true, status: true },
    }),
    getAcceptedConnectionIds(currentUserId),
  ]);

  for (const connection of directConnections) {
    const targetUserId =
      connection.requesterId === currentUserId ? connection.addresseeId : connection.requesterId;
    if (connection.status === 'accepted') {
      connectionStatusByUser.set(targetUserId, 'connected');
    } else if (connection.status === 'pending') {
      connectionStatusByUser.set(
        targetUserId,
        connection.requesterId === currentUserId ? 'pending_sent' : 'pending_received'
      );
    }
  }

  const mutualConnectionIds = currentConnectionIds.slice(0, MAX_MUTUAL_CONNECTION_SCAN_IDS);
  if (mutualConnectionIds.length > 0) {
    const mutualRows = await prisma.connections.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: { in: uniqueTargetIds }, addresseeId: { in: mutualConnectionIds } },
          { requesterId: { in: mutualConnectionIds }, addresseeId: { in: uniqueTargetIds } },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const mutualSetsByUser = new Map<string, Set<string>>();
    for (const connection of mutualRows) {
      const targetUserId = targetIdSet.has(connection.requesterId)
        ? connection.requesterId
        : targetIdSet.has(connection.addresseeId)
          ? connection.addresseeId
          : null;
      if (!targetUserId) continue;

      const mutualUserId =
        connection.requesterId === targetUserId ? connection.addresseeId : connection.requesterId;
      const mutualSet = mutualSetsByUser.get(targetUserId) || new Set<string>();
      mutualSet.add(mutualUserId);
      mutualSetsByUser.set(targetUserId, mutualSet);
    }

    for (const [targetUserId, mutualSet] of mutualSetsByUser) {
      mutualConnectionsByUser.set(targetUserId, mutualSet.size);
    }
  }

  return { connectionStatusByUser, mutualConnectionsByUser };
};

const getCurrentUserContext = async (userId: string) => {
  const cacheKey = getCurrentUserContextCacheKey(userId);
  const cached = await cacheService.get<any>(cacheKey);
  if (cached) return cached;

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      headline: true,
      college: true,
      branch: true,
      interests: true,
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

  if (currentUser) {
    await cacheService.set(
      cacheKey,
      currentUser,
      TALK_CURRENT_USER_CONTEXT_CACHE_TTL_SECONDS,
      [`user:${userId}`, 'talk:current-user-context']
    );
  }

  return currentUser;
};

const buildPeopleWhere = (userId: string, terms: string[], currentUser: any): any => {
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

  const where: any = {
    isBanned: false,
    id: { not: userId },
  };

  if (orClauses.length > 0) {
    where.OR = orClauses;
  }

  return where;
};

const reasonPush = (reasons: string[], reason: string): void => {
  if (!reasons.includes(reason) && reasons.length < 5) {
    reasons.push(reason);
  }
};

const buildConnectReason = (user: any, reasons: string[]): string => {
  const strongestReasons = reasons.slice(0, 2);
  if (strongestReasons.length > 0) {
    return `${user.name} is a strong match because ${strongestReasons.join(' and ').toLowerCase()}.`;
  }

  if (user.headline) {
    return `${user.name}'s profile lines up with this search through their headline and profile focus.`;
  }

  return `${user.name}'s profile has enough overlap to be worth checking first.`;
};

const scoreCandidate = (
  user: any,
  currentUser: any,
  terms: string[],
  relationship: RelationshipSummary
): TalkPersonCard => {
  const skills = user.skills?.map((item: any) => item.skill.name).filter(Boolean) || [];
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

const findRecommendedPeople = async (
  userId: string,
  terms: string[],
  currentUser: any
): Promise<TalkPersonCard[]> => {
  const users = await prisma.user.findMany({
    where: buildPeopleWhere(userId, terms, currentUser),
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

const sanitizeHistory = (value: unknown): TalkHistoryItem[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(-MAX_HISTORY_ITEMS)
    .map((item): TalkHistoryItem | null => {
      if (!item || typeof item !== 'object') return null;
      const role = (item as { role?: unknown }).role;
      if (role !== 'user' && role !== 'assistant') return null;
      const content = normalizeText((item as { content?: unknown }).content, 800, true);
      if (!content) return null;
      return { role, content };
    })
    .filter((item): item is TalkHistoryItem => Boolean(item));
};

const fallbackFollowUps = (mode: TalkMode, hasPeople: boolean): string[] => {
  if (mode === 'people_discovery' || hasPeople) {
    return [
      'Show me people from my college',
      'Who can help me learn this faster?',
      'Find people open to building together',
    ];
  }

  return [
    'Help me find the right people',
    'Turn this into a small action plan',
    'What should I do next?',
  ];
};

const fallbackAnswer = (message: string, mode: TalkMode, people: TalkPersonCard[], terms: string[]): string => {
  if (mode === 'people_discovery') {
    if (people.length > 0) {
      const topic = terms.slice(0, 3).join(', ') || message;
      return `I found ${people.length} strong ${people.length === 1 ? 'match' : 'matches'} for ${topic}. I ranked them using profile skills, interests, college overlap, activity, and connection status.`;
    }

    return 'I could not find a strong match yet. Try naming a skill, college, domain, or goal and I will search again.';
  }

  return 'I can help with people discovery, planning, learning paths, and next steps. Tell me what you want to find or build.';
};

const parseAIJson = (
  raw: string
): {
  answer?: string;
  followUpQuestions?: string[];
  peopleReasons?: Array<{ id?: string; reason?: string; username?: string }>;
  peopleTitle?: string;
} => {
  try {
    const direct = JSON.parse(raw);
    return direct && typeof direct === 'object' ? direct : {};
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return { answer: raw };
    }

    try {
      const extracted = JSON.parse(match[0]);
      return extracted && typeof extracted === 'object' ? extracted : { answer: raw };
    } catch {
      return { answer: raw };
    }
  }
};

const buildAIPrompt = (params: {
  currentUser: any;
  history: TalkHistoryItem[];
  message: string;
  mode: TalkMode;
  people: TalkPersonCard[];
  terms: string[];
}): string => {
  const currentUser = params.currentUser;
  return JSON.stringify({
    userMessage: params.message,
    mode: params.mode,
    searchTerms: params.terms,
    currentUser: currentUser
      ? {
          name: currentUser.name,
          headline: currentUser.headline,
          college: currentUser.college,
          branch: currentUser.branch,
          skills: currentUser.skills?.map((item: any) => item.skill.name).slice(0, 10) || [],
          interests: compactList(currentUser.interests).slice(0, 10),
          onboarding: currentUser.user_onboarding || null,
        }
      : null,
    recentHistory: params.history,
    people: params.people.map((person) => ({
      id: person.id,
      name: person.name,
      username: person.username,
      headline: person.headline,
      college: person.college,
      branch: person.branch,
      skills: person.skills.slice(0, 8),
      interests: person.interests.slice(0, 6),
      matchScore: person.matchScore,
      reasons: person.reasons,
      fallbackConnectReason: person.connectReason,
      connectionStatus: person.connectionStatus,
      mutualConnections: person.mutualConnections,
    })),
  });
};

const getAIResponse = async (params: {
  currentUser: any;
  history: TalkHistoryItem[];
  message: string;
  mode: TalkMode;
  people: TalkPersonCard[];
  requestId: string;
  terms: string[];
  userId: string;
}): Promise<{
  answer: string;
  followUpQuestions: string[];
  peopleReasonsById: Map<string, string>;
  peopleTitle?: string;
}> => {
  const systemPrompt = [
    'You are Talk with Vormex, a focused assistant inside a student professional network.',
    'You cannot navigate, control, or modify the app UI. You only answer and use structured database results supplied by the backend.',
    'Use recommended people only when they are supplied. Tell the user the cards are shown below instead of listing every field.',
    'For each supplied person, write one useful connect reason under 18 words that explains why the person matches the user.',
    'Ask practical follow-up questions that help narrow people, skills, goals, college, project type, or next action.',
    'Return JSON only with keys: answer (string), peopleTitle (string), followUpQuestions (array of 3 short strings), peopleReasons (array of {id, reason}).',
    'Keep the answer under 85 words.',
  ].join(' ');

  const raw = await aiService.complete(
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildAIPrompt(params),
      },
    ],
    {
      maxTokens: 520,
      metadata: {
        requestId: params.requestId,
        route: 'talk-turn',
        userId: params.userId,
      },
      reasoningEffort: 'none',
      temperature: 0.35,
      timeoutMs: 12_000,
    }
  );

  const parsed = parseAIJson(raw);
  const validPeopleIds = new Set(params.people.map((person) => person.id));
  const peopleReasonsById = new Map<string, string>();
  if (Array.isArray(parsed.peopleReasons)) {
    for (const item of parsed.peopleReasons) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id : '';
      const reason = typeof item.reason === 'string' ? item.reason.trim().slice(0, 180) : '';
      if (id && reason && validPeopleIds.has(id)) {
        peopleReasonsById.set(id, reason);
      }
    }
  }

  return {
    answer: typeof parsed.answer === 'string' && parsed.answer.trim()
      ? parsed.answer.trim().slice(0, 900)
      : fallbackAnswer(params.message, params.mode, params.people, params.terms),
    peopleTitle: typeof parsed.peopleTitle === 'string' && parsed.peopleTitle.trim()
      ? parsed.peopleTitle.trim().slice(0, 80)
      : undefined,
    followUpQuestions: Array.isArray(parsed.followUpQuestions)
      ? parsed.followUpQuestions
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim().slice(0, 80))
          .slice(0, 3)
      : [],
    peopleReasonsById,
  };
};

export const runTalkTurn = async (
  req: AuthenticatedRequest,
  res: Response<TalkTurnResponse | ErrorResponse>
): Promise<void> => {
  const requestId = getRequestId(req) || randomUUID();
  const log = getRequestLogger(req);
  const userId = req.user?.userId ? String(req.user.userId) : null;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const message = normalizeText(req.body?.message, 1200);
  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  try {
    const history = sanitizeHistory(req.body?.history);
    const currentUser = await getCurrentUserContext(userId);
    const mode: TalkMode = shouldSearchPeople(message) ? 'people_discovery' : 'general';
    const terms = extractSearchTerms(message);
    const people = mode === 'people_discovery'
      ? await findRecommendedPeople(userId, terms, currentUser)
      : [];

    let aiAnswer: {
      answer: string;
      followUpQuestions: string[];
      peopleReasonsById?: Map<string, string>;
      peopleTitle?: string;
    };

    try {
      aiAnswer = await getAIResponse({
        currentUser,
        history,
        message,
        mode,
        people,
        requestId,
        terms,
        userId,
      });
    } catch (error) {
      const fallbackError = error as Error;
      log.warn({
        event: 'talk.ai.fallback',
        requestId,
        userId,
        message: fallbackError.message,
      });
      aiAnswer = {
        answer: fallbackAnswer(message, mode, people, terms),
        followUpQuestions: fallbackFollowUps(mode, people.length > 0),
      };
    }

    const followUpQuestions = aiAnswer.followUpQuestions.length > 0
      ? aiAnswer.followUpQuestions.slice(0, 3)
      : fallbackFollowUps(mode, people.length > 0);
    const peopleWithConnectReasons = people.map((person) => ({
      ...person,
      connectReason: aiAnswer.peopleReasonsById?.get(person.id) || person.connectReason,
    }));

    res.status(200).json({
      answer: aiAnswer.answer,
      costMode: 'retrieval_first',
      followUpQuestions,
      mode,
      people: peopleWithConnectReasons,
      peopleTitle: aiAnswer.peopleTitle || (peopleWithConnectReasons.length > 0 ? 'Recommended people' : undefined),
    });
  } catch (error) {
    const err = error as Error;
    log.error({
      event: 'talk.turn.failure',
      requestId,
      userId,
      message: err.message,
    });
    res.status(500).json({ error: 'Talk with Vormex is unavailable right now' });
  }
};

const emptyRecentActivity = {
  items: [],
  totalCount: 0,
  hasMore: false,
};

const defaultPreviewStats = {
  xp: 0,
  level: 1,
  xpToNextLevel: 100,
  totalPosts: 0,
  totalArticles: 0,
  totalShortVideos: 0,
  totalForumQuestions: 0,
  totalForumAnswers: 0,
  totalComments: 0,
  totalLikesReceived: 0,
  connectionsCount: 0,
  followersCount: 0,
  currentStreak: 0,
  longestStreak: 0,
  lastActiveDate: null,
  totalActiveDays: 0,
};

const isProfileOnline = (user: { isOnline?: boolean | null; lastActiveAt?: Date | null }): boolean => {
  if (user.isOnline) return true;
  if (!user.lastActiveAt) return false;
  return Date.now() - user.lastActiveAt.getTime() < 5 * 60 * 1000;
};

const resolveTalkProfileIdentifier = (value: unknown): string => {
  const sanitized = normalizeText(value, 120, false);
  return sanitized.startsWith('@') ? sanitized.slice(1) : sanitized;
};

export const getTalkProfilePreview = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  const requestId = getRequestId(req) || randomUUID();
  const log = getRequestLogger(req);
  const requestingUserId = req.user?.userId ? String(req.user.userId) : null;
  const identifier = resolveTalkProfileIdentifier(req.params.userId);

  if (!requestingUserId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!identifier) {
    res.status(400).json({ error: 'User ID or username is required' });
    return;
  }

  try {
    const lookupCacheKey = getProfilePreviewLookupCacheKey(identifier);
    const cachedByIdentifier = await cacheService.get<any>(lookupCacheKey);
    if (cachedByIdentifier) {
      res.status(200).json(cachedByIdentifier);
      return;
    }

    const user = await prisma.user.findFirst({
      where: isUUID(identifier)
        ? { id: identifier, isBanned: false }
        : { username: identifier.toLowerCase(), isBanned: false },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        bannerImageUrl: true,
        headline: true,
        bio: true,
        location: true,
        college: true,
        degree: true,
        branch: true,
        currentYear: true,
        graduationYear: true,
        portfolioUrl: true,
        linkedinUrl: true,
        githubConnected: true,
        githubUsername: true,
        githubAvatarUrl: true,
        githubProfileUrl: true,
        githubLastSyncedAt: true,
        isOpenToOpportunities: true,
        isOnline: true,
        lastActiveAt: true,
        isVerified: true,
        interests: true,
        profileRing: true,
        visitLoaderGiftId: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const cacheKey = getProfilePreviewCacheKey(user.id);
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) {
      await cacheService.set(
        lookupCacheKey,
        cached,
        TALK_PROFILE_PREVIEW_CACHE_TTL_SECONDS,
        [`user:${user.id}`, 'talk:profile-preview']
      );
      res.status(200).json(cached);
      return;
    }

    const [
      userStats,
      githubStats,
      userSkills,
      experiences,
      educationHistory,
      projects,
      certificates,
      achievements,
    ] = await Promise.all([
      prisma.userStats.findUnique({
        where: { userId: user.id },
        select: {
          xp: true,
          level: true,
          totalPosts: true,
          totalArticles: true,
          totalShortVideos: true,
          totalForumQuestions: true,
          totalForumAnswers: true,
          totalComments: true,
          totalLikesReceived: true,
          connectionsCount: true,
          followersCount: true,
          currentStreak: true,
          longestStreak: true,
          lastActiveDate: true,
          totalActiveDays: true,
        },
      }).catch(() => null),
      user.githubConnected
        ? prisma.gitHubStats.findUnique({
            where: { userId: user.id },
            select: {
              totalPublicRepos: true,
              totalStars: true,
              totalForks: true,
              followers: true,
              following: true,
              topLanguages: true,
              topRepos: true,
            },
          }).catch(() => null)
        : Promise.resolve(null),
      prisma.userSkill.findMany({
        where: { userId: user.id },
        include: { skill: true },
        orderBy: { createdAt: 'desc' },
        take: 24,
      }).catch(() => []),
      prisma.experience.findMany({
        where: { userId: user.id },
        orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
        take: 8,
      }).catch(() => []),
      prisma.education.findMany({
        where: { userId: user.id },
        orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
        take: 8,
      }).catch(() => []),
      prisma.project.findMany({
        where: { userId: user.id },
        orderBy: [{ featured: 'desc' }, { startDate: 'desc' }],
        take: 8,
      }).catch(() => []),
      prisma.certificate.findMany({
        where: { userId: user.id },
        orderBy: { issueDate: 'desc' },
        take: 8,
      }).catch(() => []),
      prisma.achievement.findMany({
        where: { userId: user.id },
        orderBy: { date: 'desc' },
        take: 8,
      }).catch(() => []),
    ]);

    const stats = {
      ...defaultPreviewStats,
      ...(userStats || {}),
      xpToNextLevel: 100,
    };

    const response = {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.profileImage,
        bannerImageUrl: user.bannerImageUrl,
        headline: user.headline,
        bio: user.bio,
        location: user.location,
        college: user.college || '',
        degree: user.degree,
        branch: user.branch || '',
        currentYear: user.currentYear,
        graduationYear: user.graduationYear,
        portfolioUrl: user.portfolioUrl,
        linkedinUrl: user.linkedinUrl,
        githubProfileUrl: user.githubProfileUrl,
        otherSocialUrls: null,
        isOpenToOpportunities: user.isOpenToOpportunities,
        isOnline: isProfileOnline(user),
        lastActiveAt: user.lastActiveAt,
        verified: user.isVerified,
        interests: user.interests || [],
        profileRing: user.profileRing,
        visitLoaderGiftId: user.visitLoaderGiftId,
        createdAt: user.createdAt,
      },
      stats,
      github: {
        connected: user.githubConnected || false,
        username: user.githubUsername,
        avatarUrl: user.githubAvatarUrl,
        profileUrl: user.githubProfileUrl,
        stats: githubStats
          ? {
              totalPublicRepos: githubStats.totalPublicRepos,
              totalStars: githubStats.totalStars,
              totalForks: githubStats.totalForks,
              followers: githubStats.followers,
              following: githubStats.following,
              topLanguages: githubStats.topLanguages || {},
              topRepos: githubStats.topRepos || [],
            }
          : null,
        contributionCalendar: null,
        lastSyncedAt: user.githubLastSyncedAt,
      },
      activityHeatmap: [],
      recentActivity: emptyRecentActivity,
      skills: userSkills.map((userSkill) => ({
        id: userSkill.id,
        skill: {
          id: userSkill.skill.id,
          name: userSkill.skill.name,
          category: userSkill.skill.category,
        },
        proficiency: userSkill.proficiency,
        yearsOfExp: userSkill.yearsOfExp,
      })),
      experiences,
      education: educationHistory,
      projects,
      certificates,
      achievements,
    };

    const cacheTags = [`user:${user.id}`, 'talk:profile-preview'];
    await Promise.all([
      cacheService.set(cacheKey, response, TALK_PROFILE_PREVIEW_CACHE_TTL_SECONDS, cacheTags),
      cacheService.set(lookupCacheKey, response, TALK_PROFILE_PREVIEW_CACHE_TTL_SECONDS, cacheTags),
    ]);

    res.status(200).json(response);
  } catch (error) {
    const err = error as Error;
    log.error({
      event: 'talk.profile_preview.failure',
      requestId,
      userId: requestingUserId,
      target: identifier,
      message: err.message,
    });
    res.status(500).json({ error: 'Profile preview is unavailable right now' });
  }
};
