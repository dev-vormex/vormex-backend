import { sanitizeStringInput } from "../../../../shared/utils/input-security.util";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prisma } from "../../../../config/prisma";
import { aiService } from "../../services/ai.service";

export type TalkRole = 'user' | 'assistant';

export type TalkMode = 'people_discovery' | 'general';

export type ConnectionStatus = 'none' | 'pending_sent' | 'pending_received' | 'connected';

export interface TalkHistoryItem {
  role: TalkRole;
  content: string;
}

export interface TalkTurnResponse {
  answer: string;
  costMode: 'retrieval_first';
  followUpQuestions: string[];
  mode: TalkMode;
  people: TalkPersonCard[];
  peopleTitle?: string;
}

export interface TalkPersonCard {
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

export interface RelationshipSummary {
  connectionStatusByUser: Map<string, ConnectionStatus>;
  mutualConnectionsByUser: Map<string, number>;
}

export const TALK_ACCEPTED_CONNECTION_CACHE_TTL_SECONDS = 30;

export const TALK_CURRENT_USER_CONTEXT_CACHE_TTL_SECONDS = 2 * 60;

export const TALK_PROFILE_PREVIEW_CACHE_TTL_SECONDS = 5 * 60;

export const MAX_HISTORY_ITEMS = 8;

export const MAX_DB_SEARCH_TERMS = 10;

export const MAX_AI_CANDIDATES = 6;

export const MAX_PEOPLE_SEARCH_POOL = 36;

export const MAX_MUTUAL_CONNECTION_SCAN_IDS = 500;

export const TECH_TERMS = [
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

export const STOP_WORDS = new Set([
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

export const PEOPLE_INTENT_PATTERNS = [
  /\b(find|show|recommend|suggest|match|connect|meet|mentor|teammate|partner|people|person|someone|who knows|knows)\b/i,
  /\b(learn from|build with|team up|collaborate|hire|follow)\b/i,
];

export const normalizeText = (value: unknown, maxLength = 1200, allowEmpty = false): string => {
  if (typeof value !== 'string') {
    return '';
  }

  const sanitized = sanitizeStringInput(value, {
    allowEmpty,
    maxLength,
  });

  return sanitized.ok ? sanitized.value || '' : '';
};

export const compactList = (values: unknown): string[] => {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .slice(0, 12);
};

export const normalizeComparable = (value: string): string => value.trim().toLowerCase();

export const toComparableSet = (values: string[]): Set<string> => new Set(values.map(normalizeComparable));

export const getAcceptedConnectionIdsCacheKey = (userId: string): string =>
  `talk:accepted-connections:${userId}`;

export const getCurrentUserContextCacheKey = (userId: string): string =>
  `talk:current-user-context:v1:${userId}`;

export const getProfilePreviewCacheKey = (userId: string): string =>
  `talk:profile-preview:v2:${userId}`;

export const getProfilePreviewLookupCacheKey = (identifier: string): string =>
  `talk:profile-preview-lookup:v2:${identifier.toLowerCase()}`;

export const getAcceptedConnectionIds = async (userId: string): Promise<string[]> => {
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

export const getRelationshipSummary = async (
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

export const getCurrentUserContext = async (userId: string) => {
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

export const reasonPush = (reasons: string[], reason: string): void => {
  if (!reasons.includes(reason) && reasons.length < 5) {
    reasons.push(reason);
  }
};

export const buildConnectReason = (user: any, reasons: string[]): string => {
  const strongestReasons = reasons.slice(0, 2);
  if (strongestReasons.length > 0) {
    return `${user.name} is a strong match because ${strongestReasons.join(' and ').toLowerCase()}.`;
  }

  if (user.headline) {
    return `${user.name}'s profile lines up with this search through their headline and profile focus.`;
  }

  return `${user.name}'s profile has enough overlap to be worth checking first.`;
};

export const sanitizeHistory = (value: unknown): TalkHistoryItem[] => {
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

export const fallbackFollowUps = (mode: TalkMode, hasPeople: boolean): string[] => {
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

export const fallbackAnswer = (message: string, mode: TalkMode, people: TalkPersonCard[], terms: string[]): string => {
  if (mode === 'people_discovery') {
    if (people.length > 0) {
      const topic = terms.slice(0, 3).join(', ') || message;
      return `I found ${people.length} strong ${people.length === 1 ? 'match' : 'matches'} for ${topic}. I ranked them using profile skills, interests, college overlap, activity, and connection status.`;
    }

    return 'I could not find a strong match yet. Try naming a skill, college, domain, or goal and I will search again.';
  }

  return 'I can help with people discovery, planning, learning paths, and next steps. Tell me what you want to find or build.';
};

export const parseAIJson = (
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

export const buildAIPrompt = (params: {
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

export const getAIResponse = async (params: {
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

export const emptyRecentActivity = {
  items: [],
  totalCount: 0,
  hasMore: false,
};

export const defaultPreviewStats = {
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

export const isProfileOnline = (user: { isOnline?: boolean | null; lastActiveAt?: Date | null }): boolean => {
  if (user.isOnline) return true;
  if (!user.lastActiveAt) return false;
  return Date.now() - user.lastActiveAt.getTime() < 5 * 60 * 1000;
};

export const resolveTalkProfileIdentifier = (value: unknown): string => {
  const sanitized = normalizeText(value, 120, false);
  return sanitized.startsWith('@') ? sanitized.slice(1) : sanitized;
};
