import { clip, compactStringList } from "./support.util";

export function normalizeProfileInterestsForAgent(values: unknown): string[] | undefined {
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

export function summarizeRecentAgentPost(post: any): Record<string, unknown> {
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

export function buildAgentCurrentUserSnapshot(user: any): Record<string, unknown> {
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

export function buildAgentCurrentUserPromptContext(snapshot: Record<string, any>): string {
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
