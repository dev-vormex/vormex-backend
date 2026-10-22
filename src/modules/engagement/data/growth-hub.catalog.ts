export type CatalogCompany = {
  id: string;
  slug: string;
  name: string;
  logo?: string | null;
  location?: string | null;
  isVerified: boolean;
  website?: string;
};

export type CatalogJob = {
  id: string;
  slug: string;
  title: string;
  description: string;
  type: string;
  location: string;
  isRemote: boolean;
  experienceLevel: string;
  skills: string[];
  companyId: string;
  isFeatured: boolean;
};

export type LearningLesson = {
  id: string;
  title: string;
  summary: string;
  durationMinutes: number;
  order: number;
  xpReward: number;
  content: string;
};

export type LearningQuiz = {
  id: string;
  title: string;
  passingScore: number;
  questions: Array<{
    id: string;
    prompt: string;
    options: string[];
    correctIndex: number;
  }>;
};

export type CatalogLearningPath = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  difficulty: string;
  estimatedHours: number;
  xpReward: number;
  thumbnail?: string | null;
  isFeatured: boolean;
  lessons: LearningLesson[];
  quiz: LearningQuiz;
};

export type CatalogChallenge = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  difficulty: string;
  xpReward: number;
  points: number;
  prompt: string;
  starterCode: Record<string, string>;
  sampleInput: string;
  sampleOutput: string;
  isDaily: boolean;
};

export type InterviewQuestion = {
  id: string;
  categoryId: string;
  title: string;
  prompt: string;
  difficulty: string;
  expectedSignals: string[];
};

export type InterviewCategory = {
  id: string;
  name: string;
  slug: string;
  description: string;
  order: number;
};

export const growthCompanies: CatalogCompany[] = [
  {
    id: 'company-campuslabs',
    slug: 'campuslabs',
    name: 'CampusLabs',
    location: 'Bengaluru, India',
    isVerified: true,
    website: 'https://campuslabs.example',
  },
  {
    id: 'company-signalstack',
    slug: 'signalstack',
    name: 'SignalStack',
    location: 'Remote first',
    isVerified: true,
    website: 'https://signalstack.example',
  },
  {
    id: 'company-buildlane',
    slug: 'buildlane',
    name: 'BuildLane',
    location: 'Hyderabad, India',
    isVerified: false,
    website: 'https://buildlane.example',
  },
  {
    id: 'company-dataforge',
    slug: 'dataforge',
    name: 'DataForge',
    location: 'Pune, India',
    isVerified: true,
    website: 'https://dataforge.example',
  },
];

export const growthJobs: CatalogJob[] = [
  {
    id: 'job-android-intern-campuslabs',
    slug: 'android-product-intern-campuslabs',
    title: 'Android Product Intern',
    description: 'Build Compose screens, wire API flows, and ship student-facing product experiments.',
    type: 'Internship',
    location: 'Bengaluru',
    isRemote: false,
    experienceLevel: 'Student',
    skills: ['Kotlin', 'Jetpack Compose', 'REST APIs'],
    companyId: 'company-campuslabs',
    isFeatured: true,
  },
  {
    id: 'job-backend-intern-signalstack',
    slug: 'backend-platform-intern-signalstack',
    title: 'Backend Platform Intern',
    description: 'Work on Express APIs, queues, observability, and realtime event fanout.',
    type: 'Internship',
    location: 'Remote',
    isRemote: true,
    experienceLevel: 'Student',
    skills: ['Node.js', 'TypeScript', 'PostgreSQL', 'Redis'],
    companyId: 'company-signalstack',
    isFeatured: true,
  },
  {
    id: 'job-growth-engineering-buildlane',
    slug: 'growth-engineering-fellow-buildlane',
    title: 'Growth Engineering Fellow',
    description: 'Prototype product loops, referral mechanics, and analytics dashboards for early users.',
    type: 'Contract',
    location: 'Hyderabad',
    isRemote: false,
    experienceLevel: 'Early career',
    skills: ['React', 'Analytics', 'Experimentation'],
    companyId: 'company-buildlane',
    isFeatured: true,
  },
  {
    id: 'job-data-science-dataforge',
    slug: 'data-science-apprentice-dataforge',
    title: 'Data Science Apprentice',
    description: 'Turn product data into recommendation features and user growth insights.',
    type: 'Part-time',
    location: 'Pune',
    isRemote: true,
    experienceLevel: 'Student',
    skills: ['Python', 'SQL', 'Recommendation Systems'],
    companyId: 'company-dataforge',
    isFeatured: true,
  },
  {
    id: 'job-community-ops-campuslabs',
    slug: 'student-community-ops-campuslabs',
    title: 'Student Community Ops Associate',
    description: 'Support campus communities, events, and creator programs inside the student network.',
    type: 'Part-time',
    location: 'Remote',
    isRemote: true,
    experienceLevel: 'Student',
    skills: ['Community', 'Writing', 'Operations'],
    companyId: 'company-campuslabs',
    isFeatured: false,
  },
];

export const learningPaths: CatalogLearningPath[] = [
  {
    id: 'path-compose-career',
    slug: 'compose-career-launchpad',
    title: 'Compose Career Launchpad',
    description: 'Ship a polished Android feature, connect it to APIs, and package it for your profile.',
    category: 'Mobile Development',
    difficulty: 'Intermediate',
    estimatedHours: 8,
    xpReward: 220,
    thumbnail: null,
    isFeatured: true,
    lessons: [
      {
        id: 'lesson-compose-architecture',
        title: 'Structure a Compose feature',
        summary: 'State, events, and ViewModel boundaries for a production screen.',
        durationMinutes: 28,
        order: 1,
        xpReward: 35,
        content: 'Define UI state first, keep side effects in the ViewModel, and expose user actions as simple events.',
      },
      {
        id: 'lesson-compose-api',
        title: 'Wire API data safely',
        summary: 'Load, error, cache, and empty states without blocking the UI.',
        durationMinutes: 34,
        order: 2,
        xpReward: 40,
        content: 'Use typed models, bounded retries, and explicit empty states so backend gaps are visible and recoverable.',
      },
      {
        id: 'lesson-compose-polish',
        title: 'Polish the interaction layer',
        summary: 'Make controls feel responsive while keeping layout stable.',
        durationMinutes: 24,
        order: 3,
        xpReward: 35,
        content: 'Pre-size interactive elements, avoid layout shifts, and preserve action feedback during network calls.',
      },
    ],
    quiz: {
      id: 'quiz-compose-career',
      title: 'Compose launchpad check',
      passingScore: 70,
      questions: [
        {
          id: 'q-compose-state',
          prompt: 'Where should long-running API calls usually live in a Compose feature?',
          options: ['Inside the composable body', 'Inside the ViewModel', 'Inside a preview function'],
          correctIndex: 1,
        },
        {
          id: 'q-compose-empty',
          prompt: 'Why do explicit empty states matter?',
          options: ['They hide backend issues', 'They make missing data understandable', 'They replace loading states'],
          correctIndex: 1,
        },
      ],
    },
  },
  {
    id: 'path-backend-api',
    slug: 'backend-api-readiness',
    title: 'Backend API Readiness',
    description: 'Design route contracts, validation, and controller behavior that mobile clients can trust.',
    category: 'Backend Development',
    difficulty: 'Intermediate',
    estimatedHours: 7,
    xpReward: 200,
    thumbnail: null,
    isFeatured: true,
    lessons: [
      {
        id: 'lesson-api-contracts',
        title: 'Write mobile-safe contracts',
        summary: 'Return predictable shapes and avoid silent placeholder data.',
        durationMinutes: 30,
        order: 1,
        xpReward: 35,
        content: 'A good mobile API keeps response shapes stable, sends useful status codes, and separates empty data from errors.',
      },
      {
        id: 'lesson-api-validation',
        title: 'Validate inputs close to the edge',
        summary: 'Normalize query params before controller logic.',
        durationMinutes: 26,
        order: 2,
        xpReward: 35,
        content: 'Clamp limits, sanitize search strings, and make enum values case-insensitive when clients send user input.',
      },
    ],
    quiz: {
      id: 'quiz-backend-api',
      title: 'API readiness check',
      passingScore: 70,
      questions: [
        {
          id: 'q-api-empty',
          prompt: 'What should a controller avoid returning for a real feature?',
          options: ['A typed empty list when data is genuinely empty', 'A permanent placeholder masquerading as complete data', 'A 404 for missing detail records'],
          correctIndex: 1,
        },
        {
          id: 'q-api-limit',
          prompt: 'What is a safe way to handle a client limit query param?',
          options: ['Trust it exactly', 'Clamp it to a server maximum', 'Ignore it always'],
          correctIndex: 1,
        },
      ],
    },
  },
  {
    id: 'path-interview-systems',
    slug: 'student-system-design',
    title: 'Student System Design',
    description: 'Practice the smallest useful version of system design for internships and campus placements.',
    category: 'Interview Prep',
    difficulty: 'Beginner',
    estimatedHours: 5,
    xpReward: 160,
    thumbnail: null,
    isFeatured: true,
    lessons: [
      {
        id: 'lesson-system-design-scope',
        title: 'Scope before diagrams',
        summary: 'Turn broad prompts into concrete requirements.',
        durationMinutes: 22,
        order: 1,
        xpReward: 30,
        content: 'Start with users, core actions, read/write volume, and failure modes before naming infrastructure.',
      },
      {
        id: 'lesson-system-design-tradeoffs',
        title: 'Name tradeoffs clearly',
        summary: 'Explain why a design choice fits the constraint.',
        durationMinutes: 25,
        order: 2,
        xpReward: 30,
        content: 'A strong answer connects consistency, latency, cost, and operational risk to the product need.',
      },
    ],
    quiz: {
      id: 'quiz-student-system-design',
      title: 'System design basics',
      passingScore: 70,
      questions: [
        {
          id: 'q-system-scope',
          prompt: 'What should come before drawing a database schema?',
          options: ['Clarifying requirements', 'Choosing a CDN', 'Writing final code'],
          correctIndex: 0,
        },
        {
          id: 'q-system-tradeoff',
          prompt: 'A good tradeoff explanation connects a choice to what?',
          options: ['A buzzword', 'A product constraint', 'A random tool'],
          correctIndex: 1,
        },
      ],
    },
  },
];

export const codingChallenges: CatalogChallenge[] = [
  {
    id: 'challenge-two-sum-signals',
    slug: 'two-sum-signals',
    title: 'Two Sum Signals',
    description: 'Find two indices whose values add up to the target.',
    category: 'Arrays',
    difficulty: 'EASY',
    xpReward: 35,
    points: 100,
    prompt: 'Given an array of integers and a target, return two distinct indices that sum to the target.',
    starterCode: {
      kotlin: 'fun twoSum(nums: IntArray, target: Int): IntArray {\n    // your code\n    return intArrayOf()\n}',
      typescript: 'function twoSum(nums: number[], target: number): number[] {\n  return [];\n}',
    },
    sampleInput: '[2, 7, 11, 15], target = 9',
    sampleOutput: '[0, 1]',
    isDaily: true,
  },
  {
    id: 'challenge-valid-campus-handle',
    slug: 'valid-campus-handle',
    title: 'Valid Campus Handle',
    description: 'Validate a username for a student networking app.',
    category: 'Strings',
    difficulty: 'EASY',
    xpReward: 30,
    points: 90,
    prompt: 'Return true when a handle is 3-20 chars and contains only letters, numbers, underscores, or dots.',
    starterCode: {
      kotlin: 'fun isValidHandle(handle: String): Boolean {\n    return false\n}',
      typescript: 'function isValidHandle(handle: string): boolean {\n  return false;\n}',
    },
    sampleInput: 'vormex.dev_01',
    sampleOutput: 'true',
    isDaily: true,
  },
  {
    id: 'challenge-merge-availability',
    slug: 'merge-availability-windows',
    title: 'Merge Availability Windows',
    description: 'Merge overlapping time windows for a mentorship schedule.',
    category: 'Intervals',
    difficulty: 'MEDIUM',
    xpReward: 55,
    points: 160,
    prompt: 'Given start/end minute pairs, merge overlaps and return sorted availability windows.',
    starterCode: {
      kotlin: 'fun mergeWindows(windows: List<Pair<Int, Int>>): List<Pair<Int, Int>> {\n    return emptyList()\n}',
      typescript: 'function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {\n  return [];\n}',
    },
    sampleInput: '[[60,120],[90,150],[240,300]]',
    sampleOutput: '[[60,150],[240,300]]',
    isDaily: true,
  },
  {
    id: 'challenge-rank-feed-events',
    slug: 'rank-feed-events',
    title: 'Rank Feed Events',
    description: 'Score feed candidates from likes, comments, saves, and freshness.',
    category: 'Sorting',
    difficulty: 'MEDIUM',
    xpReward: 60,
    points: 180,
    prompt: 'Calculate scores for posts and return ids ordered from highest to lowest score.',
    starterCode: {
      kotlin: 'fun rankPosts(posts: List<PostSignal>): List<String> {\n    return emptyList()\n}',
      typescript: 'function rankPosts(posts: PostSignal[]): string[] {\n  return [];\n}',
    },
    sampleInput: 'posts with engagement signals',
    sampleOutput: 'ids sorted by score',
    isDaily: true,
  },
];

export const interviewCategories: InterviewCategory[] = [
  {
    id: 'interview-data-structures',
    name: 'Data Structures',
    slug: 'data-structures',
    description: 'Arrays, maps, stacks, queues, trees, and how to discuss tradeoffs.',
    order: 1,
  },
  {
    id: 'interview-algorithms',
    name: 'Algorithms',
    slug: 'algorithms',
    description: 'Complexity, search, sorting, dynamic programming, and problem decomposition.',
    order: 2,
  },
  {
    id: 'interview-system-design',
    name: 'System Design',
    slug: 'system-design',
    description: 'APIs, data models, scaling basics, and reliability for student-level interviews.',
    order: 3,
  },
  {
    id: 'interview-behavioral',
    name: 'Behavioral',
    slug: 'behavioral',
    description: 'Tell clear stories about ownership, conflict, learning, and leadership.',
    order: 4,
  },
  {
    id: 'interview-mobile',
    name: 'Android and Mobile',
    slug: 'android-mobile',
    description: 'Compose, lifecycle, offline states, performance, and API integration.',
    order: 5,
  },
  {
    id: 'interview-backend',
    name: 'Backend',
    slug: 'backend',
    description: 'REST contracts, auth, queues, database indexes, and production debugging.',
    order: 6,
  },
];

export const interviewQuestions: InterviewQuestion[] = [
  {
    id: 'question-map-vs-list',
    categoryId: 'interview-data-structures',
    title: 'Map vs list lookup',
    prompt: 'When would you choose a hash map over a list, and what tradeoffs come with that choice?',
    difficulty: 'EASY',
    expectedSignals: ['lookup complexity', 'memory tradeoff', 'key uniqueness'],
  },
  {
    id: 'question-binary-search',
    categoryId: 'interview-algorithms',
    title: 'Binary search boundaries',
    prompt: 'Explain how you avoid infinite loops and off-by-one errors in binary search.',
    difficulty: 'MEDIUM',
    expectedSignals: ['loop invariant', 'mid calculation', 'termination condition'],
  },
  {
    id: 'question-chat-system',
    categoryId: 'interview-system-design',
    title: 'Design a small chat service',
    prompt: 'Design the first version of one-to-one chat for a campus app.',
    difficulty: 'MEDIUM',
    expectedSignals: ['message model', 'realtime delivery', 'read receipts', 'offline behavior'],
  },
  {
    id: 'question-conflict-story',
    categoryId: 'interview-behavioral',
    title: 'Disagreement with a teammate',
    prompt: 'Tell me about a time you disagreed with a teammate and how you resolved it.',
    difficulty: 'EASY',
    expectedSignals: ['specific context', 'actions taken', 'outcome', 'reflection'],
  },
  {
    id: 'question-compose-state',
    categoryId: 'interview-mobile',
    title: 'Compose state ownership',
    prompt: 'How do you decide what state belongs in a composable versus a ViewModel?',
    difficulty: 'MEDIUM',
    expectedSignals: ['lifecycle', 'business state', 'UI state', 'side effects'],
  },
  {
    id: 'question-api-rate-limits',
    categoryId: 'interview-backend',
    title: 'API rate limits',
    prompt: 'How would you protect a public API endpoint from abuse without hurting normal users?',
    difficulty: 'MEDIUM',
    expectedSignals: ['identity keys', 'IP fallback', 'windows', 'user feedback'],
  },
];

export function clampLimit(value: unknown, fallback = 10, max = 50): number {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

export function queryText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

export function routeParam(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

export function matchesQuery(fields: Array<string | null | undefined>, query: string): boolean {
  if (!query) return true;
  return fields.some((field) => (field || '').toLowerCase().includes(query));
}

export function findCompany(companyId: string): CatalogCompany | null {
  return growthCompanies.find((company) => company.id === companyId) || null;
}

export function findLearningLesson(lessonId: string): {
  path: CatalogLearningPath;
  lesson: LearningLesson;
} | null {
  for (const path of learningPaths) {
    const lesson = path.lessons.find((item) => item.id === lessonId);
    if (lesson) return { path, lesson };
  }
  return null;
}

export function findLearningQuiz(quizId: string): {
  path: CatalogLearningPath;
  quiz: LearningQuiz;
} | null {
  for (const path of learningPaths) {
    if (path.quiz.id === quizId) return { path, quiz: path.quiz };
  }
  return null;
}

export function dailyChallengeForDate(date = new Date()): CatalogChallenge {
  const daily = codingChallenges.filter((challenge) => challenge.isDaily);
  const dayNumber = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
  return daily[dayNumber % daily.length] || codingChallenges[0];
}

export function categoryQuestionCount(categoryId: string): number {
  return interviewQuestions.filter((question) => question.categoryId === categoryId).length;
}
