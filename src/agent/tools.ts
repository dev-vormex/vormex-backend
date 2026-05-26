import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { getConnectionRequestLimitState } from '../services/tier-limits.service';
import { AgentActionRecord, AgentToolExecutionContext, AgentToolResult, AgentUiIntent } from './types';
import { evaluateToolExecutionPolicy, getAgentToolPolicy } from './action-policy.service';

type ConnectionState = 'none' | 'pending_sent' | 'pending_received' | 'connected';

const agentUserSelect = {
  id: true,
  name: true,
  username: true,
  profileImage: true,
  headline: true,
  bio: true,
  college: true,
  branch: true,
  location: true,
  currentCity: true,
  currentCountry: true,
  isOnline: true,
  lastActiveAt: true,
  interests: true,
  latitude: true,
  longitude: true,
  skills: {
    take: 6,
    select: {
      skill: {
        select: {
          name: true,
        },
      },
    },
  },
  user_onboarding: {
    select: {
      primaryGoal: true,
      lookingFor: true,
      wantToLearn: true,
      canTeach: true,
    },
  },
  userStats: {
    select: {
      connectionsCount: true,
      xp: true,
      level: true,
    },
  },
};

const agentCurrentUserContextSelect = {
  id: true,
  name: true,
  username: true,
  profileImage: true,
  headline: true,
  bio: true,
  college: true,
  branch: true,
  degree: true,
  currentYear: true,
  graduationYear: true,
  location: true,
  currentCity: true,
  currentCountry: true,
  portfolioUrl: true,
  linkedinUrl: true,
  githubProfileUrl: true,
  isOpenToOpportunities: true,
  interests: true,
  skills: {
    take: 12,
    orderBy: { createdAt: 'desc' as const },
    select: {
      proficiency: true,
      yearsOfExp: true,
      skill: {
        select: {
          name: true,
          category: true,
        },
      },
    },
  },
  user_onboarding: {
    select: {
      primaryGoal: true,
      lookingFor: true,
      wantToLearn: true,
      canTeach: true,
    },
  },
  userStats: {
    select: {
      connectionsCount: true,
      xp: true,
      level: true,
    },
  },
  experiences: {
    take: 3,
    orderBy: [{ isCurrent: 'desc' as const }, { startDate: 'desc' as const }],
    select: {
      title: true,
      company: true,
      type: true,
      isCurrent: true,
      skills: true,
    },
  },
  educationHistory: {
    take: 2,
    orderBy: [{ isCurrent: 'desc' as const }, { startDate: 'desc' as const }],
    select: {
      school: true,
      degree: true,
      fieldOfStudy: true,
      isCurrent: true,
    },
  },
  projects: {
    take: 4,
    orderBy: [{ featured: 'desc' as const }, { startDate: 'desc' as const }],
    select: {
      name: true,
      description: true,
      role: true,
      techStack: true,
      featured: true,
      isCurrent: true,
      projectUrl: true,
      githubUrl: true,
    },
  },
  certificates: {
    take: 3,
    orderBy: { issueDate: 'desc' as const },
    select: {
      name: true,
      issuingOrg: true,
    },
  },
  achievements: {
    take: 3,
    orderBy: { date: 'desc' as const },
    select: {
      title: true,
      organization: true,
      type: true,
    },
  },
  posts: {
    take: 3,
    where: {
      isActive: true,
    },
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      type: true,
      content: true,
      likesCount: true,
      commentsCount: true,
      createdAt: true,
    },
  },
};

function nullableStringSchema() {
  return {
    type: ['string', 'null'],
  };
}

function nullableIntegerSchema(minimum: number, maximum: number) {
  return {
    type: ['integer', 'null'],
    minimum,
    maximum,
  };
}

function nullableBooleanSchema() {
  return {
    type: ['boolean', 'null'],
  };
}

function nullableStringArraySchema(maxItems: number) {
  return {
    type: ['array', 'null'],
    maxItems,
    items: {
      type: 'string',
    },
  };
}

function strictObjectParameters(properties: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

const agentToolSchemas = [
  {
    type: 'function',
    name: 'people_search',
    description:
      'Search for people in Vormex using keywords, skills, interests, college, branch, headline, bio, or nearby discovery. Use this for requests like "python people", "React developers", or "AI students".',
    strict: true,
    parameters: strictObjectParameters({
      query: nullableStringSchema(),
      limit: nullableIntegerSchema(1, 10),
      nearbyOnly: nullableBooleanSchema(),
    }),
  },
  {
    type: 'function',
    name: 'matching_find_like_minded_peers',
    description: 'Find the best like-minded peer matches for the current user.',
    strict: true,
    parameters: strictObjectParameters({
      focus: nullableStringSchema(),
      limit: nullableIntegerSchema(1, 10),
    }),
  },
  {
    type: 'function',
    name: 'connections_send_request',
    description: 'Send a connection request to another user.',
    strict: true,
    parameters: strictObjectParameters({
      userId: { type: 'string' },
      note: nullableStringSchema(),
    }),
  },
  {
    type: 'function',
    name: 'connections_accept_request',
    description: 'Accept a pending connection request by connection ID.',
    strict: true,
    parameters: strictObjectParameters({
      connectionId: { type: 'string' },
    }),
  },
  {
    type: 'function',
    name: 'chat_open_conversation',
    description: 'Open or create a one-to-one chat conversation with a user.',
    strict: true,
    parameters: strictObjectParameters({
      userId: { type: 'string' },
    }),
  },
  {
    type: 'function',
    name: 'chat_send_message',
    description: 'Send a direct message to a user.',
    strict: true,
    parameters: strictObjectParameters({
      userId: { type: 'string' },
      message: { type: 'string' },
    }),
  },
  {
    type: 'function',
    name: 'groups_discover',
    description:
      'Discover public groups by keyword or tag. Use this only when the user explicitly asks for groups, communities, clubs, or joining a group, not when they ask for people with a skill or interest.',
    strict: true,
    parameters: strictObjectParameters({
      query: nullableStringSchema(),
      tag: nullableStringSchema(),
      limit: nullableIntegerSchema(1, 10),
    }),
  },
  {
    type: 'function',
    name: 'groups_join',
    description: 'Join a public group by group ID.',
    strict: true,
    parameters: strictObjectParameters({
      groupId: { type: 'string' },
    }),
  },
  {
    type: 'function',
    name: 'profile_get_me',
    description: 'Get the current user profile summary.',
    strict: true,
    parameters: strictObjectParameters({}),
  },
  {
    type: 'function',
    name: 'profile_get_user',
    description: 'Get another user profile summary by user ID.',
    strict: true,
    parameters: strictObjectParameters({
      userId: { type: 'string' },
    }),
  },
  {
    type: 'function',
    name: 'profile_update_summary',
    description:
      'Prepare an update to the current user profile headline, bio, or interests. This always requires explicit approval before it writes.',
    strict: true,
    parameters: strictObjectParameters({
      headline: nullableStringSchema(),
      bio: nullableStringSchema(),
      interests: nullableStringArraySchema(10),
    }),
  },
  {
    type: 'function',
    name: 'posts_create_text',
    description:
      'Prepare a text-only post for the current user. This always requires explicit approval before it publishes.',
    strict: true,
    parameters: strictObjectParameters({
      content: { type: 'string' },
      visibility: nullableStringSchema(),
    }),
  },
  {
    type: 'function',
    name: 'growth_get_snapshot',
    description: 'Get a compact growth snapshot for the current user.',
    strict: true,
    parameters: strictObjectParameters({}),
  },
  {
    type: 'function',
    name: 'notifications_get_summary',
    description: 'Get a summary of recent notifications and unread counts.',
    strict: true,
    parameters: strictObjectParameters({
      unreadOnly: nullableBooleanSchema(),
      limit: nullableIntegerSchema(1, 20),
    }),
  },
  {
    type: 'function',
    name: 'notifications_mark_all_read',
    description: 'Mark all notifications as read.',
    strict: true,
    parameters: strictObjectParameters({}),
  },
  {
    type: 'function',
    name: 'ui_navigate',
    description: 'Return a structured UI navigation intent for the Android app.',
    strict: true,
    parameters: strictObjectParameters({
      target: { type: 'string' },
      tab: nullableStringSchema(),
      userId: nullableStringSchema(),
      conversationId: nullableStringSchema(),
      groupId: nullableStringSchema(),
      note: nullableStringSchema(),
    }),
  },
];

function clip(text: string | null | undefined, maxLength: number): string | null {
  if (!text) return null;
  const normalized = text.trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function compactStringList(
  values: Array<string | null | undefined>,
  maxItems: number = values.length
): string[] {
  const seen = new Set<string>();
  const items: string[] = [];

  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalized);
  });

  return items.slice(0, maxItems);
}

function normalizeProfileInterestsForAgent(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = values
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 2 && value.length <= 30)
    .map((value) =>
      value
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
    );

  return Array.from(new Map(normalized.map((value) => [value.toLowerCase(), value])).values()).slice(
    0,
    10
  );
}

function summarizeRecentAgentPost(post: any): Record<string, unknown> {
  return {
    id: post.id,
    type: post.type || 'post',
    content: clip(post.content, 160),
    likesCount: Number(post.likesCount || 0),
    commentsCount: Number(post.commentsCount || 0),
    createdAt:
      post.createdAt instanceof Date ? post.createdAt.toISOString() : String(post.createdAt || ''),
  };
}

function buildAgentCurrentUserSnapshot(user: any): Record<string, unknown> {
  const skills = (user.skills || [])
    .map((item: any) => ({
      name: item.skill?.name || null,
      category: item.skill?.category || null,
      proficiency: item.proficiency || null,
      yearsOfExp: item.yearsOfExp ?? null,
    }))
    .filter((item: any) => Boolean(item.name));

  const experiences = (user.experiences || []).map((item: any) => ({
    title: item.title,
    company: item.company,
    type: item.type,
    isCurrent: Boolean(item.isCurrent),
    skills: compactStringList(item.skills || [], 5),
  }));

  const education = (user.educationHistory || []).map((item: any) => ({
    school: item.school,
    degree: item.degree,
    fieldOfStudy: item.fieldOfStudy,
    isCurrent: Boolean(item.isCurrent),
  }));

  const projects = (user.projects || []).map((item: any) => ({
    name: item.name,
    role: item.role || null,
    description: clip(item.description, 160),
    techStack: compactStringList(item.techStack || [], 6),
    featured: Boolean(item.featured),
    isCurrent: Boolean(item.isCurrent),
    projectUrl: item.projectUrl || null,
    githubUrl: item.githubUrl || null,
  }));

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    headline: user.headline || null,
    bio: clip(user.bio, 220),
    college: user.college || null,
    branch: user.branch || null,
    degree: user.degree || null,
    currentYear: user.currentYear ?? null,
    graduationYear: user.graduationYear ?? null,
    location:
      compactStringList([user.location, user.currentCity, user.currentCountry], 3).join(', ') || null,
    portfolioUrl: user.portfolioUrl || null,
    linkedinUrl: user.linkedinUrl || null,
    githubProfileUrl: user.githubProfileUrl || null,
    isOpenToOpportunities: Boolean(user.isOpenToOpportunities),
    interests: compactStringList(user.interests || [], 10),
    skills,
    onboarding: {
      primaryGoal: user.user_onboarding?.primaryGoal || null,
      lookingFor: compactStringList(user.user_onboarding?.lookingFor || [], 6),
      wantToLearn: compactStringList(user.user_onboarding?.wantToLearn || [], 8),
      canTeach: compactStringList(user.user_onboarding?.canTeach || [], 8),
    },
    stats: user.userStats
      ? {
          connectionsCount: Number(user.userStats.connectionsCount || 0),
          xp: Number(user.userStats.xp || 0),
          level: Number(user.userStats.level || 0),
        }
      : null,
    experiences,
    education,
    projects,
    certificates: (user.certificates || []).map((item: any) => ({
      name: item.name,
      issuingOrg: item.issuingOrg,
    })),
    achievements: (user.achievements || []).map((item: any) => ({
      title: item.title,
      organization: item.organization,
      type: item.type,
    })),
    recentPosts: (user.posts || []).map(summarizeRecentAgentPost),
  };
}

function buildAgentCurrentUserPromptContext(snapshot: Record<string, any>): string {
  const skills = compactStringList(
    Array.isArray(snapshot.skills) ? snapshot.skills.map((item: any) => item?.name) : [],
    8
  );
  const interests = compactStringList(Array.isArray(snapshot.interests) ? snapshot.interests : [], 8);
  const goals = [
    snapshot.onboarding?.primaryGoal ? `primary goal: ${snapshot.onboarding.primaryGoal}` : null,
    Array.isArray(snapshot.onboarding?.lookingFor) && snapshot.onboarding.lookingFor.length > 0
      ? `looking for: ${snapshot.onboarding.lookingFor.join(', ')}`
      : null,
    Array.isArray(snapshot.onboarding?.wantToLearn) && snapshot.onboarding.wantToLearn.length > 0
      ? `wants to learn: ${snapshot.onboarding.wantToLearn.join(', ')}`
      : null,
    Array.isArray(snapshot.onboarding?.canTeach) && snapshot.onboarding.canTeach.length > 0
      ? `can teach: ${snapshot.onboarding.canTeach.join(', ')}`
      : null,
  ].filter(Boolean);
  const experienceLine = Array.isArray(snapshot.experiences)
    ? snapshot.experiences
        .map((item: any) => [item.title, item.company].filter(Boolean).join(' at '))
        .filter(Boolean)
        .join('; ')
    : '';
  const educationLine = Array.isArray(snapshot.education)
    ? snapshot.education
        .map((item: any) => [item.school, item.degree, item.fieldOfStudy].filter(Boolean).join(' · '))
        .filter(Boolean)
        .join('; ')
    : '';
  const projectsLine = Array.isArray(snapshot.projects)
    ? snapshot.projects
        .map((item: any) => {
          const techStack = Array.isArray(item.techStack) && item.techStack.length > 0
            ? ` (${item.techStack.join(', ')})`
            : '';
          return `${item.name}${techStack}`;
        })
        .filter(Boolean)
        .join('; ')
    : '';
  const postsLine = Array.isArray(snapshot.recentPosts)
    ? snapshot.recentPosts
        .map((item: any) => {
          const type = String(item.type || 'post').toLowerCase();
          const content = clip(item.content, 90);
          return content ? `[${type}] ${content}` : null;
        })
        .filter(Boolean)
        .join('; ')
    : '';

  return [
    `Current user: ${[snapshot.name, snapshot.username ? `(@${snapshot.username})` : null].filter(Boolean).join(' ')}`,
    snapshot.headline ? `Headline: ${snapshot.headline}` : null,
    snapshot.bio ? `Bio: ${snapshot.bio}` : null,
    [snapshot.college, snapshot.branch, snapshot.degree].some(Boolean)
      ? `College context: ${[snapshot.college, snapshot.branch, snapshot.degree].filter(Boolean).join(' · ')}`
      : null,
    snapshot.location ? `Location: ${snapshot.location}` : null,
    skills.length > 0 ? `Skills: ${skills.join(', ')}` : null,
    interests.length > 0 ? `Interests: ${interests.join(', ')}` : null,
    goals.length > 0 ? `Goals and preferences: ${goals.join(' | ')}` : null,
    experienceLine ? `Experience: ${clip(experienceLine, 240)}` : null,
    educationLine ? `Education: ${clip(educationLine, 220)}` : null,
    projectsLine ? `Projects: ${clip(projectsLine, 240)}` : null,
    Array.isArray(snapshot.certificates) && snapshot.certificates.length > 0
      ? `Certificates: ${clip(snapshot.certificates.map((item: any) => item.name).join(', '), 180)}`
      : null,
    Array.isArray(snapshot.achievements) && snapshot.achievements.length > 0
      ? `Achievements: ${clip(snapshot.achievements.map((item: any) => item.title).join(', '), 180)}`
      : null,
    postsLine ? `Recent posts: ${clip(postsLine, 300)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function sharedInterests(a: string[] = [], b: string[] = []): string[] {
  const target = new Set((b || []).map((item) => item.toLowerCase()));
  return (a || []).filter((item) => target.has(item.toLowerCase()));
}

const PEOPLE_SEARCH_STOP_WORDS = new Set([
  'people',
  'person',
  'persons',
  'user',
  'users',
  'profile',
  'profiles',
  'peer',
  'peers',
  'show',
  'find',
  'search',
  'open',
  'browse',
  'get',
  'me',
  'my',
  'with',
  'for',
  'who',
  'that',
  'those',
  'some',
  'campus',
  'college',
  'colleges',
]);

function queryRequestsCurrentUsersCampus(query: string | null | undefined): boolean {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /\b(my|our|same)\s+(campus|college)\b/.test(normalized) ||
    /\bfrom\s+(my|our)\s+(campus|college)\b/.test(normalized) ||
    /\b(on|in)\s+(my|our)\s+(campus|college)\b/.test(normalized) ||
    /\bfrom\s+same\s+(campus|college)\b/.test(normalized)
  );
}

function buildPeopleSearchTerms(query: string | null | undefined): string[] {
  const normalized = String(query || '').trim();
  if (!normalized) return [];

  const rawTokens = normalized.toLowerCase().match(/[a-z0-9+#.]+/g) || [];
  const keywordTokens = rawTokens.filter(
    (token) => token.length > 1 && !PEOPLE_SEARCH_STOP_WORDS.has(token)
  );
  const terms = normalized.includes(' ')
    ? keywordTokens.length > 0
      ? [normalized, ...keywordTokens]
      : []
    : keywordTokens;

  return Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean))).slice(0, 8);
}

function buildPeopleSearchVariants(term: string): string[] {
  const normalized = term.trim();
  if (!normalized) return [];

  const variants = new Set<string>([normalized, normalized.toLowerCase()]);
  variants.add(
    normalized.replace(/\b\w/g, (segment) => segment.toUpperCase())
  );

  return Array.from(variants).filter(Boolean);
}

function buildPeopleSearchClauses(terms: string[]): any[] {
  const clauses: any[] = [];

  terms.forEach((term) => {
    buildPeopleSearchVariants(term).forEach((variant) => {
      clauses.push(
        { name: { contains: variant, mode: 'insensitive' } },
        { username: { contains: variant, mode: 'insensitive' } },
        { headline: { contains: variant, mode: 'insensitive' } },
        { bio: { contains: variant, mode: 'insensitive' } },
        { college: { contains: variant, mode: 'insensitive' } },
        { branch: { contains: variant, mode: 'insensitive' } },
        { interests: { has: variant } },
        {
          user_onboarding: {
            is: {
              OR: [
                { primaryGoal: { contains: variant, mode: 'insensitive' } },
                { wantToLearn: { has: variant } },
                { canTeach: { has: variant } },
              ],
            },
          },
        }
      );
    });

    clauses.push({
      skills: {
        some: {
          skill: {
            name: { contains: term, mode: 'insensitive' },
          },
        },
      },
    });
  });

  return clauses;
}

function scoreUserAgainstPeopleSearch(user: any, terms: string[]): number {
  if (terms.length === 0) return 0;

  const normalizedTerms = terms.map((term) => term.toLowerCase());
  const name = String(user.name || '').toLowerCase();
  const username = String(user.username || '').toLowerCase();
  const headline = String(user.headline || '').toLowerCase();
  const bio = String(user.bio || '').toLowerCase();
  const college = String(user.college || '').toLowerCase();
  const branch = String(user.branch || '').toLowerCase();
  const interests = (user.interests || []).map((item: string) => String(item || '').toLowerCase());
  const skills = (user.skills || [])
    .map((item: any) => String(item.skill?.name || '').toLowerCase())
    .filter(Boolean);
  const wantToLearn = (user.user_onboarding?.wantToLearn || []).map((item: string) =>
    String(item || '').toLowerCase()
  );
  const canTeach = (user.user_onboarding?.canTeach || []).map((item: string) =>
    String(item || '').toLowerCase()
  );
  const primaryGoal = String(user.user_onboarding?.primaryGoal || '').toLowerCase();

  let score = 0;

  normalizedTerms.forEach((term) => {
    if (name.includes(term)) score += 14;
    if (username.includes(term)) score += 12;
    if (headline.includes(term)) score += 14;
    if (bio.includes(term)) score += 8;
    if (college.includes(term)) score += 6;
    if (branch.includes(term)) score += 6;
    if (primaryGoal.includes(term)) score += 8;
    if (skills.some((item) => item.includes(term))) score += 20;
    if (interests.some((item) => item.includes(term))) score += 18;
    if (wantToLearn.some((item) => item.includes(term))) score += 12;
    if (canTeach.some((item) => item.includes(term))) score += 12;
  });

  return score;
}

function calculateDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function actionRecord(params: {
  type: string;
  toolName: string;
  status: 'executed' | 'suggested' | 'blocked';
  title: string;
  summary: string;
  entityId?: string | null;
  entityType?: string | null;
  uiIntents?: AgentUiIntent[];
  payload?: Record<string, unknown>;
  riskLevel?: AgentActionRecord['riskLevel'];
  autonomyMode?: AgentActionRecord['autonomyMode'];
}): AgentActionRecord {
  const toolPolicy = getAgentToolPolicy(params.toolName);
  return {
    type: params.type,
    toolName: params.toolName,
    status: params.status,
    title: params.title,
    summary: params.summary,
    entityId: params.entityId || null,
    entityType: params.entityType || null,
    uiIntents: params.uiIntents || [],
    payload: params.payload || null,
    riskLevel: params.riskLevel || toolPolicy.riskLevel,
    autonomyMode: params.autonomyMode,
  };
}

function switchTabIntent(tab: string): AgentUiIntent {
  return {
    type: 'switch_tab',
    tab,
  };
}

function openProfileIntent(userId: string): AgentUiIntent {
  return {
    type: 'open_profile',
    userId,
  };
}

function openChatIntent(params: { userId?: string; conversationId?: string }): AgentUiIntent {
  return {
    type: 'open_chat',
    userId: params.userId,
    conversationId: params.conversationId,
  };
}

function openGroupIntent(groupId: string): AgentUiIntent {
  return {
    type: 'open_group',
    groupId,
  };
}

function openGrowthIntent(note?: string): AgentUiIntent {
  return {
    type: 'open_growth_task',
    label: note || 'Open Growth Hub',
  };
}

function showInlineResultsIntent(payload: Record<string, unknown>): AgentUiIntent {
  return {
    type: 'show_inline_results',
    payload,
  };
}

async function buildConnectionMetadata(currentUserId: string, targetUserIds: string[]) {
  const uniqueTargetIds = Array.from(new Set(targetUserIds.filter(Boolean)));
  const connectionStatusMap = new Map<string, ConnectionState>();
  const mutualConnectionsMap = new Map<string, number>(
    uniqueTargetIds.map((targetUserId) => [targetUserId, 0])
  );

  if (uniqueTargetIds.length === 0) {
    return { connectionStatusMap, mutualConnectionsMap };
  }

  const currentUserConnections = await prisma.connections.findMany({
    where: {
      OR: [{ requesterId: currentUserId }, { addresseeId: currentUserId }],
    },
    select: {
      requesterId: true,
      addresseeId: true,
      status: true,
    },
  });

  const acceptedConnectionIds = new Set<string>();

  for (const connection of currentUserConnections) {
    const otherUserId =
      connection.requesterId === currentUserId
        ? connection.addresseeId
        : connection.requesterId;

    if (connection.status === 'accepted') {
      connectionStatusMap.set(otherUserId, 'connected');
      acceptedConnectionIds.add(otherUserId);
      continue;
    }

    if (connection.status === 'pending') {
      connectionStatusMap.set(
        otherUserId,
        connection.requesterId === currentUserId ? 'pending_sent' : 'pending_received'
      );
    }
  }

  if (acceptedConnectionIds.size === 0) {
    return { connectionStatusMap, mutualConnectionsMap };
  }

  const relatedAcceptedConnections = await prisma.connections.findMany({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: { in: uniqueTargetIds } },
        { addresseeId: { in: uniqueTargetIds } },
      ],
    },
    select: {
      requesterId: true,
      addresseeId: true,
    },
  });

  const targetSet = new Set(uniqueTargetIds);
  const connectionBuckets = new Map<string, Set<string>>(
    uniqueTargetIds.map((targetUserId) => [targetUserId, new Set<string>()])
  );

  for (const connection of relatedAcceptedConnections) {
    if (targetSet.has(connection.requesterId)) {
      connectionBuckets.get(connection.requesterId)?.add(connection.addresseeId);
    }

    if (targetSet.has(connection.addresseeId)) {
      connectionBuckets.get(connection.addresseeId)?.add(connection.requesterId);
    }
  }

  for (const [targetUserId, connectedIds] of connectionBuckets.entries()) {
    let mutualCount = 0;

    connectedIds.forEach((connectedId) => {
      if (acceptedConnectionIds.has(connectedId)) {
        mutualCount += 1;
      }
    });

    mutualConnectionsMap.set(targetUserId, mutualCount);
  }

  return { connectionStatusMap, mutualConnectionsMap };
}

function summarizeUser(
  user: any,
  currentUser?: any,
  connectionStatus: ConnectionState = 'none',
  mutualConnections: number = 0
): Record<string, unknown> {
  const overlap = currentUser ? sharedInterests(user.interests || [], currentUser.interests || []) : [];
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    profileImage: user.profileImage || null,
    headline: user.headline || null,
    bio: clip(user.bio, 160),
    college: user.college || null,
    branch: user.branch || null,
    location: user.location || user.currentCity || null,
    interests: user.interests || [],
    sharedInterests: overlap,
    skills: (user.skills || []).map((item: any) => item.skill?.name).filter(Boolean),
    isOnline: Boolean(user.isOnline),
    connectionStatus,
    mutualConnections,
    stats: user.userStats
      ? {
          connectionsCount: user.userStats.connectionsCount,
          xp: user.userStats.xp,
          level: user.userStats.level,
        }
      : null,
  };
}

async function getCurrentUserContext(userId: string): Promise<any> {
  return prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: agentUserSelect,
  });
}

export async function getAgentCurrentUserContext(userId: string): Promise<{
  snapshot: Record<string, unknown>;
  promptContext: string;
} | null> {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: agentCurrentUserContextSelect,
  });

  if (!user) {
    return null;
  }

  const snapshot = buildAgentCurrentUserSnapshot(user);
  return {
    snapshot,
    promptContext: buildAgentCurrentUserPromptContext(snapshot),
  };
}

async function getOrCreateConversationForUsers(userId: string, otherUserId: string): Promise<any> {
  let conversation = await prisma.conversations.findFirst({
    where: {
      OR: [
        { participant1Id: userId, participant2Id: otherUserId },
        { participant1Id: otherUserId, participant2Id: userId },
      ],
    },
  });

  if (!conversation) {
    conversation = await prisma.conversations.create({
      data: {
        id: randomUUID(),
        participant1Id: userId,
        participant2Id: otherUserId,
      },
    });
  }

  return conversation;
}

function maybeGateAction(
  toolName: string,
  ctx: AgentToolExecutionContext,
  params: {
    type: string;
    title: string;
    summary: string;
    entityId?: string | null;
    entityType?: string | null;
    uiIntents?: AgentUiIntent[];
    payload?: Record<string, unknown>;
  }
): AgentToolResult | null {
  const policyDecision = evaluateToolExecutionPolicy(toolName, ctx);
  const effectiveAutonomyMode =
    ctx.effectiveAutonomyMode ||
    ctx.autonomyMode ||
    (ctx.allowAutonomousActions ? 'power' : 'approval');

  if (policyDecision.canExecute) {
    return null;
  }

  if (!policyDecision.shouldCreateApproval) {
    const blockedAction = actionRecord({
      type: params.type,
      toolName,
      status: 'blocked',
      title: params.title,
      summary: `${params.summary} This action is blocked by Vormex safety policy.`,
      entityId: params.entityId,
      entityType: params.entityType,
      uiIntents: params.uiIntents,
      payload: params.payload,
      riskLevel: policyDecision.policy.riskLevel,
      autonomyMode: effectiveAutonomyMode,
    });

    return {
      summary: blockedAction.summary,
      output: {
        status: 'blocked',
        reason: policyDecision.reason,
        riskLevel: policyDecision.policy.riskLevel,
        autonomyMode: effectiveAutonomyMode,
        uiIntents: params.uiIntents || [],
      },
      blockedAction,
      uiIntents: params.uiIntents || [],
    };
  }

  const suggestedAction = actionRecord({
    type: params.type,
    toolName,
    status: 'suggested',
    title: params.title,
    summary: params.summary,
    entityId: params.entityId,
    entityType: params.entityType,
    uiIntents: params.uiIntents,
    payload: params.payload,
    riskLevel: policyDecision.policy.riskLevel,
    autonomyMode: effectiveAutonomyMode,
  });

  return {
    summary:
      policyDecision.policy.riskLevel === 'approval_required'
        ? `${params.summary} This action always needs your approval first.`
        : `${params.summary} I saved it for approval because power mode is unavailable or off.`,
    output: {
      status: 'approval_required',
      reason: policyDecision.reason,
      suggestion: params.summary,
      riskLevel: policyDecision.policy.riskLevel,
      autonomyMode: effectiveAutonomyMode,
      powerModeEligible: Boolean(ctx.powerModeEligible),
      uiIntents: params.uiIntents || [],
    },
    suggestedAction,
    uiIntents: params.uiIntents || [],
  };
}

export function getAgentToolDefinitions(): any[] {
  return agentToolSchemas as any[];
}

export async function executeAgentTool(
  toolName: string,
  args: Record<string, any>,
  ctx: AgentToolExecutionContext
): Promise<AgentToolResult> {
  const currentUser = await getCurrentUserContext(ctx.userId);

  switch (toolName) {
    case 'people_search': {
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 8));
      const query = clip(args.query, 80) || '';
      const searchTerms = buildPeopleSearchTerms(query);
      const hasSearchTerms = searchTerms.length > 0;
      const nearbyOnly = Boolean(args.nearbyOnly);
      const sameCampusOnly = queryRequestsCurrentUsersCampus(query);
      const where: any = {
        id: { not: ctx.userId },
        isBanned: false,
      };

      if (sameCampusOnly) {
        if (!currentUser?.college) {
          return {
            summary: 'I cannot filter by your campus yet because your college is missing from your profile.',
            output: {
              status: 'blocked',
              reason: 'current_user_college_missing',
            },
            blockedAction: actionRecord({
              type: 'people_search',
              toolName,
              status: 'blocked',
              title: 'Campus filter unavailable',
              summary: 'Your college is missing, so campus-only discovery is unavailable right now.',
            }),
          };
        }

        where.college = currentUser.college;
      }

      if (searchTerms.length > 0) {
        where.OR = buildPeopleSearchClauses(searchTerms);
      }

      const candidates = await prisma.user.findMany({
        where,
        orderBy: { lastActiveAt: 'desc' },
        take: nearbyOnly ? 50 : Math.max(limit * 6, 36),
        select: agentUserSelect,
      });
      const displayQuery = hasSearchTerms ? query : '';
      const { connectionStatusMap, mutualConnectionsMap } = await buildConnectionMetadata(
        ctx.userId,
        candidates.map((candidate) => candidate.id)
      );

      const people: any[] = candidates
        .map((user) => {
          const person = summarizeUser(
            user,
            currentUser,
            connectionStatusMap.get(user.id) || 'none',
            mutualConnectionsMap.get(user.id) || 0
          );
          const queryScore = hasSearchTerms ? scoreUserAgainstPeopleSearch(user, searchTerms) : 0;
          let distanceKm: number | null = null;
          if (
            nearbyOnly &&
            currentUser?.latitude !== null &&
            currentUser?.latitude !== undefined &&
            currentUser?.longitude !== null &&
            currentUser?.longitude !== undefined &&
            user.latitude !== null &&
            user.latitude !== undefined &&
            user.longitude !== null &&
            user.longitude !== undefined
          ) {
            distanceKm = calculateDistanceKm(
              Number(currentUser.latitude),
              Number(currentUser.longitude),
              Number(user.latitude),
              Number(user.longitude)
            );
          }

          return {
            ...person,
            distanceKm,
            queryScore,
          };
        })
        .filter(
          (item: any) =>
            (!nearbyOnly || item.distanceKm !== null) &&
            (!hasSearchTerms || item.queryScore > 0)
        )
        .sort((a: any, b: any) => {
          const overlapA = Array.isArray(a.sharedInterests) ? a.sharedInterests.length : 0;
          const overlapB = Array.isArray(b.sharedInterests) ? b.sharedInterests.length : 0;
          if (nearbyOnly) {
            return Number(a.distanceKm || 9999) - Number(b.distanceKm || 9999);
          }
          if (Number(b.queryScore || 0) !== Number(a.queryScore || 0)) {
            return Number(b.queryScore || 0) - Number(a.queryScore || 0);
          }
          return overlapB - overlapA;
        })
        .slice(0, limit)
        .map(({ queryScore: _queryScore, ...person }) => person);

      if (people.length === 0) {
        const fallbackSummary = nearbyOnly
          ? 'I could not find nearby people here, so I’m opening Find to look deeper.'
          : sameCampusOnly
            ? 'I could not find strong campus matches here, so I’m opening Find to look deeper.'
            : 'I could not find strong people here, so I’m opening Find to look deeper.';

        return {
          summary: fallbackSummary,
          output: {
            status: 'executed',
            people: [],
            totalCount: 0,
            hasMore: false,
          },
          executedAction: actionRecord({
            type: nearbyOnly ? 'people_nearby' : 'people_search',
            toolName,
            status: 'executed',
            title: nearbyOnly ? 'Checking nearby people in Find' : 'Checking people in Find',
            summary: fallbackSummary,
            uiIntents: [switchTabIntent('find')],
          }),
          uiIntents: [switchTabIntent('find')],
        };
      }

      const shownPeople = people.slice(0, 5);
      const summary = nearbyOnly
        ? `Found ${people.length} nearby people${displayQuery ? ` for "${displayQuery}"` : ''}.`
        : sameCampusOnly
          ? `Found ${people.length} people from ${currentUser?.college}${displayQuery ? ` for "${displayQuery}"` : ''}.`
          : `Found ${people.length} people${displayQuery ? ` for "${displayQuery}"` : ''}.`;
      const title = nearbyOnly
        ? 'Nearby people to check out'
        : sameCampusOnly
          ? 'People from your campus'
          : 'People worth opening';
      const subtitle = nearbyOnly
        ? displayQuery
          ? `Closest people for ${displayQuery}`
          : 'Best nearby matches without leaving this screen'
        : sameCampusOnly
          ? displayQuery
            ? `Top ${currentUser?.college} matches for ${displayQuery}`
            : `Best matches from ${currentUser?.college}`
          : displayQuery
            ? `Top matches for ${displayQuery}`
            : 'Best matches without leaving this screen';
      const inlinePayload = {
        resultType: 'people',
        title,
        subtitle,
        source: nearbyOnly ? 'people_nearby' : sameCampusOnly ? 'people_same_campus' : 'people_search',
        people: shownPeople,
        shownCount: shownPeople.length,
        totalCount: people.length,
        fallbackNavigationTarget: 'find_people',
      };

      return {
        summary,
        output: {
          status: 'executed',
          people: shownPeople,
          totalCount: people.length,
          hasMore: people.length > shownPeople.length,
        },
        executedAction: actionRecord({
          type: nearbyOnly ? 'people_nearby' : sameCampusOnly ? 'people_same_campus' : 'people_search',
          toolName,
          status: 'executed',
          title: nearbyOnly ? 'Found nearby people' : sameCampusOnly ? 'Found campus people' : 'Searched people',
          summary,
          uiIntents: [showInlineResultsIntent(inlinePayload)],
          payload: inlinePayload,
        }),
        uiIntents: [showInlineResultsIntent(inlinePayload)],
      };
    }

    case 'matching_find_like_minded_peers': {
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 8));
      const focus = clip(args.focus, 80) || '';
      const existingConnections = await prisma.connections.findMany({
        where: {
          OR: [{ requesterId: ctx.userId }, { addresseeId: ctx.userId }],
        },
        select: {
          requesterId: true,
          addresseeId: true,
        },
      });
      const excludedIds = new Set<string>([ctx.userId]);
      existingConnections.forEach((connection) => {
        excludedIds.add(connection.requesterId);
        excludedIds.add(connection.addresseeId);
      });

      const candidates = await prisma.user.findMany({
        where: {
          id: { notIn: Array.from(excludedIds) },
          isBanned: false,
        },
        orderBy: { lastActiveAt: 'desc' },
        take: Math.max(24, limit * 5),
        select: agentUserSelect,
      });
      const { connectionStatusMap, mutualConnectionsMap } = await buildConnectionMetadata(
        ctx.userId,
        candidates.map((candidate) => candidate.id)
      );

      const matches = candidates
        .map((user) => {
          const reasons: string[] = [];
          let score = 0;

          if (currentUser?.college && user.college === currentUser.college) {
            score += 25;
            reasons.push('same college');
          }
          if (currentUser?.branch && user.branch === currentUser.branch) {
            score += 15;
            reasons.push('same branch');
          }

          const overlap = sharedInterests(user.interests || [], currentUser?.interests || []);
          if (overlap.length > 0) {
            score += overlap.length * 10;
            reasons.push(`${overlap.length} shared interest${overlap.length > 1 ? 's' : ''}`);
          }

          if (
            currentUser?.user_onboarding?.primaryGoal &&
            currentUser.user_onboarding.primaryGoal === user.user_onboarding?.primaryGoal
          ) {
            score += 20;
            reasons.push('same goal');
          }

          const currentWantToLearn = currentUser?.user_onboarding?.wantToLearn || [];
          const currentCanTeach = currentUser?.user_onboarding?.canTeach || [];
          const candidateWantToLearn = user.user_onboarding?.wantToLearn || [];
          const candidateCanTeach = user.user_onboarding?.canTeach || [];

          if (sharedInterests(currentWantToLearn, candidateCanTeach).length > 0) {
            score += 12;
            reasons.push('can teach what you want to learn');
          }

          if (sharedInterests(currentCanTeach, candidateWantToLearn).length > 0) {
            score += 12;
            reasons.push('could benefit from what you can teach');
          }

          if (focus) {
            const searchable = [
              user.headline,
              user.bio,
              ...(user.interests || []),
              ...(user.skills || []).map((item: any) => item.skill?.name || ''),
            ]
              .join(' ')
              .toLowerCase();
            if (searchable.includes(focus.toLowerCase())) {
              score += 8;
              reasons.push(`aligned with ${focus}`);
            }
          }

          return {
            user: summarizeUser(
              user,
              currentUser,
              connectionStatusMap.get(user.id) || 'none',
              mutualConnectionsMap.get(user.id) || 0
            ),
            score,
            reasons,
          };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (matches.length === 0) {
        const fallbackSummary = focus
          ? `I could not find strong ${focus} matches here, so I’m opening Find to search deeper.`
          : 'I could not find strong like-minded matches here, so I’m opening Find to search deeper.';

        return {
          summary: fallbackSummary,
          output: {
            status: 'executed',
            matches: [],
            totalCount: 0,
            hasMore: false,
          },
          executedAction: actionRecord({
            type: 'match_people',
            toolName,
            status: 'executed',
            title: 'Searching deeper in Find',
            summary: fallbackSummary,
            uiIntents: [switchTabIntent('find')],
          }),
          uiIntents: [switchTabIntent('find')],
        };
      }

      const shownMatches = matches.slice(0, 5);
      const inlinePeople = shownMatches.map((match) => ({
        ...match.user,
        matchReasons: match.reasons,
        matchScore: match.score,
      }));
      const summary = `Ranked ${matches.length} like-minded peer matches${focus ? ` around ${focus}` : ''}.`;
      const inlinePayload = {
        resultType: 'people',
        title: focus ? `Best matches for ${focus}` : 'Like-minded people for you',
        subtitle: focus
          ? 'Top ranked peers without leaving this screen'
          : 'Top ranked peers based on your goals, interests, and network',
        source: 'matching_find_like_minded_peers',
        people: inlinePeople,
        shownCount: inlinePeople.length,
        totalCount: matches.length,
        fallbackNavigationTarget: 'find_people',
      };

      return {
        summary,
        output: {
          status: 'executed',
          matches: shownMatches,
          totalCount: matches.length,
          hasMore: matches.length > shownMatches.length,
        },
        executedAction: actionRecord({
          type: 'match_people',
          toolName,
          status: 'executed',
          title: 'Found like-minded peers',
          summary,
          uiIntents: [showInlineResultsIntent(inlinePayload)],
          payload: inlinePayload,
        }),
        uiIntents: [showInlineResultsIntent(inlinePayload)],
      };
    }

    case 'connections_send_request': {
      const targetUserId = String(args.userId || '');
      if (!targetUserId || targetUserId === ctx.userId) {
        return {
          summary: 'I need a valid user to send a connection request.',
          output: {
            status: 'blocked',
            reason: 'invalid_user',
          },
          blockedAction: actionRecord({
            type: 'send_connection_request',
            toolName,
            status: 'blocked',
            title: 'Could not send connection request',
            summary: 'The requested user ID was invalid.',
          }),
        };
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'send_connection_request',
        title: 'Prepared a connection request',
        summary: 'I found the user and prepared the connection request.',
        entityId: targetUserId,
        entityType: 'user',
        uiIntents: [openProfileIntent(targetUserId)],
      });
      if (gated) return gated;

      const existing = await prisma.connections.findFirst({
        where: {
          OR: [
            { requesterId: ctx.userId, addresseeId: targetUserId },
            { requesterId: targetUserId, addresseeId: ctx.userId },
          ],
        },
      });
      if (existing) {
        return {
          summary: 'A connection already exists or is already pending.',
          output: {
            status: 'blocked',
            reason: 'already_connected_or_pending',
            connectionId: existing.id,
          },
          blockedAction: actionRecord({
            type: 'send_connection_request',
            toolName,
            status: 'blocked',
            title: 'Connection request not sent',
            summary: 'This connection is already pending or already accepted.',
            entityId: existing.id,
            entityType: 'connection',
          }),
        };
      }

      const limitState = await getConnectionRequestLimitState(ctx.userId);
      if (!limitState.allowed) {
        return {
          summary: 'Free accounts can send up to 10 connection requests per month. Premium unlocks unlimited requests.',
          output: {
            status: 'blocked',
            reason: 'connection_request_limit_reached',
            limit: limitState.limit,
            used: limitState.used,
            remaining: limitState.remaining,
          },
          blockedAction: actionRecord({
            type: 'send_connection_request',
            toolName,
            status: 'blocked',
            title: 'Connection request limit reached',
            summary: 'The monthly free connection request limit has been reached.',
          }),
        };
      }

      const connection = await prisma.connections.create({
        data: {
          id: randomUUID(),
          requesterId: ctx.userId,
          addresseeId: targetUserId,
          status: 'pending',
        },
      });

      const uiIntents = [openProfileIntent(targetUserId), switchTabIntent('find')];
      const summary = 'Sent the connection request.';
      return {
        summary,
        output: {
          status: 'executed',
          connectionId: connection.id,
        },
        executedAction: actionRecord({
          type: 'send_connection_request',
          toolName,
          status: 'executed',
          title: 'Sent connection request',
          summary,
          entityId: connection.id,
          entityType: 'connection',
          uiIntents,
        }),
        uiIntents,
      };
    }

    case 'connections_accept_request': {
      const connectionId = String(args.connectionId || '');
      if (!connectionId) {
        return {
          summary: 'I need a connection ID to accept the request.',
          output: {
            status: 'blocked',
            reason: 'missing_connection_id',
          },
          blockedAction: actionRecord({
            type: 'accept_connection_request',
            toolName,
            status: 'blocked',
            title: 'Could not accept request',
            summary: 'No connection ID was provided.',
          }),
        };
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'accept_connection_request',
        title: 'Prepared to accept a connection request',
        summary: 'I found the pending connection request and can accept it.',
        entityId: connectionId,
        entityType: 'connection',
        uiIntents: [switchTabIntent('find')],
      });
      if (gated) return gated;

      const connection = await prisma.connections.findFirst({
        where: {
          id: connectionId,
          addresseeId: ctx.userId,
        },
      });

      if (!connection || connection.status !== 'pending') {
        return {
          summary: 'That connection request is no longer available.',
          output: {
            status: 'blocked',
            reason: 'connection_not_pending',
          },
          blockedAction: actionRecord({
            type: 'accept_connection_request',
            toolName,
            status: 'blocked',
            title: 'Connection request unavailable',
            summary: 'The request was not found or is no longer pending.',
            entityId: connectionId,
            entityType: 'connection',
          }),
        };
      }

      await prisma.$transaction([
        prisma.connections.update({
          where: { id: connectionId },
          data: { status: 'accepted' },
        }),
        prisma.userStats.updateMany({
          where: {
            userId: {
              in: [connection.requesterId, connection.addresseeId],
            },
          },
          data: {
            connectionsCount: { increment: 1 },
          },
        }),
      ]);

      const summary = 'Accepted the connection request.';
      return {
        summary,
        output: {
          status: 'executed',
          connectionId,
        },
        executedAction: actionRecord({
          type: 'accept_connection_request',
          toolName,
          status: 'executed',
          title: 'Accepted connection request',
          summary,
          entityId: connectionId,
          entityType: 'connection',
          uiIntents: [switchTabIntent('find')],
        }),
        uiIntents: [switchTabIntent('find')],
      };
    }

    case 'chat_open_conversation': {
      const targetUserId = String(args.userId || '');
      if (!targetUserId || targetUserId === ctx.userId) {
        return {
          summary: 'I need a valid other user to open chat.',
          output: {
            status: 'blocked',
            reason: 'invalid_user',
          },
          blockedAction: actionRecord({
            type: 'open_chat',
            toolName,
            status: 'blocked',
            title: 'Could not open chat',
            summary: 'The requested user was invalid.',
          }),
        };
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'open_chat',
        title: 'Prepared a chat handoff',
        summary: 'I found the user and can open the chat thread.',
        entityId: targetUserId,
        entityType: 'user',
        uiIntents: [openChatIntent({ userId: targetUserId })],
      });
      if (gated) return gated;

      const conversation = await getOrCreateConversationForUsers(ctx.userId, targetUserId);
      const uiIntents = [openChatIntent({ userId: targetUserId, conversationId: conversation.id })];
      const summary = 'Opened the chat thread.';
      return {
        summary,
        output: {
          status: 'executed',
          conversationId: conversation.id,
          targetUserId,
        },
        executedAction: actionRecord({
          type: 'open_chat',
          toolName,
          status: 'executed',
          title: 'Opened chat',
          summary,
          entityId: conversation.id,
          entityType: 'conversation',
          uiIntents,
        }),
        uiIntents,
      };
    }

    case 'chat_send_message': {
      const targetUserId = String(args.userId || '');
      const message = clip(String(args.message || ''), 1000);
      if (!targetUserId || !message || targetUserId === ctx.userId) {
        return {
          summary: 'I need a valid user and message before sending.',
          output: {
            status: 'blocked',
            reason: 'invalid_message_request',
          },
          blockedAction: actionRecord({
            type: 'send_message',
            toolName,
            status: 'blocked',
            title: 'Could not send message',
            summary: 'The message request was incomplete.',
          }),
        };
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'send_message',
        title: 'Prepared a direct message',
        summary: 'I drafted the message and can send it when autonomous actions are enabled.',
        entityId: targetUserId,
        entityType: 'user',
        uiIntents: [openChatIntent({ userId: targetUserId })],
        payload: {
          message,
        },
      });
      if (gated) return gated;

      const conversation = await getOrCreateConversationForUsers(ctx.userId, targetUserId);
      const receiverId =
        conversation.participant1Id === ctx.userId
          ? conversation.participant2Id
          : conversation.participant1Id;

      const createdMessage = await prisma.messages.create({
        data: {
          id: randomUUID(),
          conversationId: conversation.id,
          senderId: ctx.userId,
          receiverId,
          content: message,
          contentType: 'text',
          status: 'SENT',
        },
      });

      await prisma.conversations.update({
        where: {
          id: conversation.id,
        },
        data: {
          lastMessageAt: new Date(),
        },
      });

      const uiIntents = [
        openChatIntent({
          userId: targetUserId,
          conversationId: conversation.id,
        }),
      ];
      const summary = 'Sent the direct message.';
      return {
        summary,
        output: {
          status: 'executed',
          conversationId: conversation.id,
          messageId: createdMessage.id,
          content: message,
        },
        executedAction: actionRecord({
          type: 'send_message',
          toolName,
          status: 'executed',
          title: 'Sent direct message',
          summary,
          entityId: createdMessage.id,
          entityType: 'message',
          uiIntents,
          payload: {
            conversationId: conversation.id,
          },
        }),
        uiIntents,
      };
    }

    case 'groups_discover': {
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
      const query = clip(args.query, 80) || '';
      const tag = clip(args.tag, 40) || '';

      const memberships = await prisma.group_members.findMany({
        where: { userId: ctx.userId },
        select: { groupId: true },
      });

      const groups = await prisma.groups.findMany({
        where: {
          id: { notIn: memberships.map((membership) => membership.groupId) },
          isPrivate: false,
          ...(query
            ? {
                OR: [
                  { name: { contains: query, mode: 'insensitive' } },
                  { description: { contains: query, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...(tag ? { tags: { has: tag } } : {}),
        },
        orderBy: { memberCount: 'desc' },
        take: limit,
        select: {
          id: true,
          name: true,
          description: true,
          tags: true,
          memberCount: true,
        },
      });

      const summary =
        groups.length > 0
          ? `Found ${groups.length} groups${query ? ` for "${query}"` : ''}.`
          : 'No good group matches appeared yet.';

      return {
        summary,
        output: {
          status: 'executed',
          groups,
        },
        executedAction: actionRecord({
          type: 'discover_groups',
          toolName,
          status: 'executed',
          title: 'Discovered groups',
          summary,
          uiIntents: [switchTabIntent('groups')],
        }),
        uiIntents: [switchTabIntent('groups')],
      };
    }

    case 'groups_join': {
      const groupId = String(args.groupId || '');
      if (!groupId) {
        return {
          summary: 'I need a group ID to join.',
          output: {
            status: 'blocked',
            reason: 'missing_group_id',
          },
          blockedAction: actionRecord({
            type: 'join_group',
            toolName,
            status: 'blocked',
            title: 'Could not join group',
            summary: 'No group ID was provided.',
          }),
        };
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'join_group',
        title: 'Prepared a group join',
        summary: 'I found the group and can join it.',
        entityId: groupId,
        entityType: 'group',
        uiIntents: [openGroupIntent(groupId)],
      });
      if (gated) return gated;

      const group = await prisma.groups.findUnique({
        where: {
          id: groupId,
        },
      });
      if (!group) {
        return {
          summary: 'That group could not be found.',
          output: {
            status: 'blocked',
            reason: 'group_not_found',
          },
          blockedAction: actionRecord({
            type: 'join_group',
            toolName,
            status: 'blocked',
            title: 'Group not found',
            summary: 'The requested group does not exist.',
            entityId: groupId,
            entityType: 'group',
          }),
        };
      }

      const existingMembership = await prisma.group_members.findUnique({
        where: {
          groupId_userId: {
            groupId,
            userId: ctx.userId,
          },
        },
      });
      if (existingMembership) {
        return {
          summary: 'You are already in that group.',
          output: {
            status: 'blocked',
            reason: 'already_joined',
          },
          blockedAction: actionRecord({
            type: 'join_group',
            toolName,
            status: 'blocked',
            title: 'Already joined group',
            summary: 'The current user is already a member of this group.',
            entityId: groupId,
            entityType: 'group',
          }),
        };
      }

      await prisma.$transaction([
        prisma.group_members.create({
          data: {
            id: randomUUID(),
            groupId,
            userId: ctx.userId,
            role: 'member',
          },
        }),
        prisma.groups.update({
          where: { id: groupId },
          data: {
            memberCount: {
              increment: 1,
            },
          },
        }),
      ]);

      const uiIntents = [openGroupIntent(groupId)];
      const summary = 'Joined the group.';
      return {
        summary,
        output: {
          status: 'executed',
          groupId,
        },
        executedAction: actionRecord({
          type: 'join_group',
          toolName,
          status: 'executed',
          title: 'Joined group',
          summary,
          entityId: groupId,
          entityType: 'group',
          uiIntents,
        }),
        uiIntents,
      };
    }

    case 'profile_get_me': {
      const currentUserContext = await getAgentCurrentUserContext(ctx.userId);
      return {
        summary: 'Loaded your full profile context.',
        output: {
          status: 'executed',
          profile: currentUserContext?.snapshot || summarizeUser(currentUser),
        },
        executedAction: actionRecord({
          type: 'profile_lookup',
          toolName,
          status: 'executed',
          title: 'Loaded your profile context',
          summary: 'Loaded your full profile context.',
          uiIntents: [switchTabIntent('profile')],
        }),
        uiIntents: [switchTabIntent('profile')],
      };
    }

    case 'profile_get_user': {
      const targetUserId = String(args.userId || '');
      const user = await prisma.user.findUnique({
        where: {
          id: targetUserId,
        },
        select: agentUserSelect,
      });

      if (!user) {
        return {
          summary: 'That user profile could not be found.',
          output: {
            status: 'blocked',
            reason: 'user_not_found',
          },
          blockedAction: actionRecord({
            type: 'profile_lookup',
            toolName,
            status: 'blocked',
            title: 'Profile not found',
            summary: 'The requested user profile does not exist.',
            entityId: targetUserId,
            entityType: 'user',
          }),
        };
      }

      const uiIntents = [openProfileIntent(targetUserId)];
      return {
        summary: 'Loaded the requested profile.',
        output: {
          status: 'executed',
          profile: summarizeUser(user, currentUser),
        },
        executedAction: actionRecord({
          type: 'profile_lookup',
          toolName,
          status: 'executed',
          title: 'Loaded profile',
          summary: 'Loaded the requested user profile.',
          entityId: targetUserId,
          entityType: 'user',
          uiIntents,
        }),
        uiIntents,
      };
    }

    case 'profile_update_summary': {
      const headline =
        args.headline !== undefined && args.headline !== null ? clip(String(args.headline), 120) : undefined;
      const bio = args.bio !== undefined && args.bio !== null ? clip(String(args.bio), 500) : undefined;
      const interests = normalizeProfileInterestsForAgent(args.interests);
      const updateData: Record<string, unknown> = {};

      if (headline !== undefined) updateData.headline = headline;
      if (bio !== undefined) updateData.bio = bio;
      if (interests !== undefined) updateData.interests = interests;

      const updatedFields = Object.keys(updateData);
      if (updatedFields.length === 0) {
        return {
          summary: 'I need at least one profile field to update.',
          output: {
            status: 'blocked',
            reason: 'missing_profile_update_fields',
          },
          blockedAction: actionRecord({
            type: 'profile_update',
            toolName,
            status: 'blocked',
            title: 'Profile update missing',
            summary: 'No supported profile fields were provided.',
            uiIntents: [switchTabIntent('profile')],
          }),
          uiIntents: [switchTabIntent('profile')],
        };
      }

      args.headline = headline ?? null;
      args.bio = bio ?? null;
      args.interests = interests ?? null;

      const summary = `Update your profile ${updatedFields.join(', ')}.`;
      const gated = maybeGateAction(toolName, ctx, {
        type: 'profile_update',
        title: 'Approve profile update',
        summary,
        entityId: ctx.userId,
        entityType: 'user',
        uiIntents: [switchTabIntent('profile')],
        payload: {
          fields: updatedFields,
          preview: updateData,
        },
      });
      if (gated) return gated;

      const updatedUser = await prisma.user.update({
        where: { id: ctx.userId },
        data: updateData,
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
          headline: true,
          bio: true,
          interests: true,
          updatedAt: true,
        },
      });

      return {
        summary: `Updated your profile ${updatedFields.join(', ')}.`,
        output: {
          status: 'executed',
          profile: updatedUser,
          fields: updatedFields,
        },
        executedAction: actionRecord({
          type: 'profile_update',
          toolName,
          status: 'executed',
          title: 'Updated profile',
          summary: `Updated your profile ${updatedFields.join(', ')}.`,
          entityId: ctx.userId,
          entityType: 'user',
          uiIntents: [switchTabIntent('profile')],
          payload: {
            fields: updatedFields,
          },
        }),
        uiIntents: [switchTabIntent('profile')],
      };
    }

    case 'posts_create_text': {
      const content = clip(String(args.content || ''), 3000);
      if (!content) {
        return {
          summary: 'I need post text before I can prepare a post.',
          output: {
            status: 'blocked',
            reason: 'missing_post_content',
          },
          blockedAction: actionRecord({
            type: 'post_create',
            toolName,
            status: 'blocked',
            title: 'Post content missing',
            summary: 'No post content was provided.',
            uiIntents: [switchTabIntent('post')],
          }),
          uiIntents: [switchTabIntent('post')],
        };
      }

      const requestedVisibility = String(args.visibility || 'public').trim().toLowerCase();
      const visibility = ['public', 'connections', 'private'].includes(requestedVisibility)
        ? requestedVisibility
        : 'public';
      args.content = content;
      args.visibility = visibility;

      const gated = maybeGateAction(toolName, ctx, {
        type: 'post_create',
        title: 'Approve post',
        summary: `Publish a ${visibility} text post.`,
        entityType: 'post',
        uiIntents: [switchTabIntent('post')],
        payload: {
          content,
          visibility,
        },
      });
      if (gated) return gated;

      const post = await prisma.post.create({
        data: {
          id: randomUUID(),
          authorId: ctx.userId,
          content,
          mediaUrls: [],
          metadata: {
            source: 'agent',
          },
          type: 'text',
          visibility,
        },
        select: {
          id: true,
          authorId: true,
          content: true,
          visibility: true,
          type: true,
          createdAt: true,
        },
      });

      return {
        summary: 'Published the text post.',
        output: {
          status: 'executed',
          post,
        },
        executedAction: actionRecord({
          type: 'post_create',
          toolName,
          status: 'executed',
          title: 'Published post',
          summary: 'Published the text post.',
          entityId: post.id,
          entityType: 'post',
          uiIntents: [switchTabIntent('feed')],
          payload: {
            postId: post.id,
            visibility,
          },
        }),
        uiIntents: [switchTabIntent('feed')],
      };
    }

    case 'growth_get_snapshot': {
      const [connectionCount, pendingConnections, unreadNotifications, partnerCount, postCount] =
        await Promise.all([
          prisma.connections.count({
            where: {
              OR: [{ requesterId: ctx.userId }, { addresseeId: ctx.userId }],
              status: 'accepted',
            },
          }),
          prisma.connections.count({
            where: {
              addresseeId: ctx.userId,
              status: 'pending',
            },
          }),
          prisma.notifications.count({
            where: {
              userId: ctx.userId,
              isRead: false,
            },
          }),
          prisma.accountability_pairs.count({
            where: {
              status: 'active',
              OR: [{ user1Id: ctx.userId }, { user2Id: ctx.userId }],
            },
          }),
          prisma.post.count({
            where: {
              authorId: ctx.userId,
            },
          }),
        ]);

      const hooks: string[] = [];
      if (!currentUser?.bio || currentUser.bio.trim().length < 20) {
        hooks.push('Add a sharper bio to improve discoverability.');
      }
      if (!currentUser?.profileImage) {
        hooks.push('Add a profile picture so people trust your outreach faster.');
      }
      if (connectionCount < 5) {
        hooks.push('Grow your network by connecting with a few aligned peers.');
      }
      if (postCount === 0) {
        hooks.push('Publish your first post to start getting inbound attention.');
      }

      const snapshot = {
        profileReady: Boolean(currentUser?.profileImage) && Boolean(currentUser?.bio),
        connectionCount,
        pendingConnections,
        unreadNotifications,
        accountabilityPartners: partnerCount,
        postCount,
        hooks,
      };

      return {
        summary: 'Loaded the growth snapshot.',
        output: {
          status: 'executed',
          snapshot,
        },
        executedAction: actionRecord({
          type: 'growth_snapshot',
          toolName,
          status: 'executed',
          title: 'Loaded growth snapshot',
          summary: 'Loaded the current growth snapshot.',
          uiIntents: [openGrowthIntent()],
        }),
        uiIntents: [openGrowthIntent()],
      };
    }

    case 'notifications_get_summary': {
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
      const unreadOnly = Boolean(args.unreadOnly);
      const [count, notifications] = await Promise.all([
        prisma.notifications.count({
          where: {
            userId: ctx.userId,
            ...(unreadOnly ? { isRead: false } : {}),
          },
        }),
        prisma.notifications.findMany({
          where: {
            userId: ctx.userId,
            ...(unreadOnly ? { isRead: false } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            type: true,
            title: true,
            body: true,
            isRead: true,
            createdAt: true,
          },
        }),
      ]);

      return {
        summary: `Loaded ${notifications.length} notifications.`,
        output: {
          status: 'executed',
          total: count,
          notifications: notifications.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
          })),
        },
        executedAction: actionRecord({
          type: 'notifications_summary',
          toolName,
          status: 'executed',
          title: 'Loaded notifications',
          summary: `Loaded ${notifications.length} notifications.`,
          uiIntents: [
            {
              type: 'open_notifications',
            },
          ],
        }),
        uiIntents: [
          {
            type: 'open_notifications',
          },
        ],
      };
    }

    case 'notifications_mark_all_read': {
      const gated = maybeGateAction(toolName, ctx, {
        type: 'notifications_mark_all_read',
        title: 'Prepared to mark notifications as read',
        summary: 'I can mark the current notifications as read.',
        uiIntents: [
          {
            type: 'open_notifications',
          },
        ],
      });
      if (gated) return gated;

      const result = await prisma.notifications.updateMany({
        where: {
          userId: ctx.userId,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      return {
        summary: 'Marked notifications as read.',
        output: {
          status: 'executed',
          updatedCount: result.count,
        },
        executedAction: actionRecord({
          type: 'notifications_mark_all_read',
          toolName,
          status: 'executed',
          title: 'Marked notifications as read',
          summary: 'Marked notifications as read.',
          uiIntents: [
            {
              type: 'open_notifications',
            },
          ],
        }),
        uiIntents: [
          {
            type: 'open_notifications',
          },
        ],
      };
    }

    case 'ui_navigate': {
      const target = String(args.target || '').toLowerCase();
      let uiIntent: AgentUiIntent | null = null;

      switch (target) {
        case 'feed':
        case 'home':
          uiIntent = switchTabIntent('feed');
          break;
        case 'find_people':
        case 'network':
        case 'find':
          uiIntent = switchTabIntent('find');
          break;
        case 'post':
        case 'create_post':
          uiIntent = switchTabIntent('post');
          break;
        case 'profile':
          uiIntent = args.userId ? openProfileIntent(String(args.userId)) : switchTabIntent('profile');
          break;
        case 'chat':
        case 'messages':
          uiIntent = openChatIntent({
            userId: args.userId ? String(args.userId) : undefined,
            conversationId: args.conversationId ? String(args.conversationId) : undefined,
          });
          break;
        case 'groups':
          uiIntent = args.groupId ? openGroupIntent(String(args.groupId)) : { type: 'open_groups' };
          break;
        case 'notifications':
          uiIntent = { type: 'open_notifications' };
          break;
        case 'growth_hub':
        case 'growth':
          uiIntent = openGrowthIntent(String(args.note || 'Open Growth Hub'));
          break;
        default:
          break;
      }

      if (!uiIntent) {
        return {
          summary: 'That navigation target is not supported yet.',
          output: {
            status: 'blocked',
            reason: 'unsupported_navigation_target',
            target,
          },
          blockedAction: actionRecord({
            type: 'navigate',
            toolName,
            status: 'blocked',
            title: 'Unsupported navigation target',
            summary: `The target "${target}" is not currently supported.`,
          }),
        };
      }

      return {
        summary: 'Prepared the UI handoff.',
        output: {
          status: 'executed',
          uiIntent,
        },
        executedAction: actionRecord({
          type: 'navigate',
          toolName,
          status: 'executed',
          title: 'Prepared navigation',
          summary: 'Prepared the UI handoff.',
          uiIntents: [uiIntent],
        }),
        uiIntents: [uiIntent],
      };
    }

    default:
      return {
        summary: `Tool ${toolName} is not implemented.`,
        output: {
          status: 'blocked',
          reason: 'tool_not_implemented',
          toolName,
        },
        blockedAction: actionRecord({
          type: 'tool_missing',
          toolName,
          status: 'blocked',
          title: 'Tool unavailable',
          summary: `The tool ${toolName} is not implemented.`,
        }),
      };
  }
}
