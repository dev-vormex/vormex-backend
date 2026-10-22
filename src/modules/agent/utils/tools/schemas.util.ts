
export const agentUserSelect = {
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
  shareLocationPublic: true,
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

export const agentCurrentUserContextSelect = {
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

export function nullableStringSchema() {
  return {
    type: ['string', 'null'],
  };
}

export function nullableIntegerSchema(minimum: number, maximum: number) {
  return {
    type: ['integer', 'null'],
    minimum,
    maximum,
  };
}

export function nullableBooleanSchema() {
  return {
    type: ['boolean', 'null'],
  };
}

export function nullableStringArraySchema(maxItems: number) {
  return {
    type: ['array', 'null'],
    maxItems,
    items: {
      type: 'string',
    },
  };
}

export function strictObjectParameters(properties: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

export const agentToolSchemas = [
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

export function getAgentToolDefinitions(): any[] {
  return agentToolSchemas as any[];
}
