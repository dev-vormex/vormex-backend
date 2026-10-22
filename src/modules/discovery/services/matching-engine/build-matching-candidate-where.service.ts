import type { PremiumVisibilityState } from "../../../premium/services/premium-visibility.service";
import { MatchingSignalUser, MatchFilterType, collectSkillNames, collectSkillsToLearn, collectInterests, collectGoals, normalizeText, uniqueLabels, parsePositiveInt, DEFAULT_MATCH_NOTIFICATION_COOLDOWN_HOURS, DEFAULT_MATCH_LOOKBACK_DAYS, DEFAULT_MAX_RECIPIENTS, STRONG_MATCH_THRESHOLD, MatchingScore, MatchNotificationSource, RECENT_ACTIVITY_WINDOW_MS } from "./matching-engine-user-select.service";
import { skillNameClauses } from "./score-user-match.service";

export function buildMatchingCandidateWhere(
  currentUser: MatchingSignalUser,
  options: {
    type?: MatchFilterType;
    excludedIds?: string[];
    lookbackBoundary?: Date;
  } = {}
) {
  const type = options.type || 'all';
  const excludedIds = Array.from(new Set([currentUser.id, ...(options.excludedIds || [])]));
  const skills = collectSkillNames(currentUser);
  const wantToLearn = collectSkillsToLearn(currentUser);
  const interests = collectInterests(currentUser);
  const goals = collectGoals(currentUser);
  const city = normalizeText(currentUser.currentCity || currentUser.location);
  const college = normalizeText(currentUser.college);
  const branch = normalizeText(currentUser.branch);

  const baseWhere: any = {
    id: { notIn: excludedIds },
    isBanned: false,
  };

  const andClauses: any[] = [];
  const orClauses: any[] = [];

  if (options.lookbackBoundary) {
    andClauses.push({
      OR: [
        { lastActiveAt: { gte: options.lookbackBoundary } },
        { createdAt: { gte: options.lookbackBoundary } },
      ],
    });
  }

  if (type === 'same_campus') {
    if (college) baseWhere.college = college;
    return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
  }

  if (type === 'same_goal') {
    if (goals.length > 0) {
      baseWhere.OR = [
        { user_onboarding: { is: { primaryGoal: { in: goals } } } },
        { user_goals: { some: { goal: { in: goals } } } },
      ];
    }
    return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
  }

  if (type === 'mentor') {
    const learnSignals = uniqueLabels(wantToLearn);
    if (learnSignals.length > 0) {
      baseWhere.OR = [
        { user_onboarding: { is: { canTeach: { hasSome: learnSignals } } } },
        ...skillNameClauses(learnSignals),
      ];
    }
    return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
  }

  if (type === 'mentee') {
    const teachSignals = uniqueLabels(skills);
    if (teachSignals.length > 0) {
      baseWhere.OR = [
        { user_onboarding: { is: { wantToLearn: { hasSome: teachSignals } } } },
      ];
    }
    return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
  }

  if (college) orClauses.push({ college });
  if (branch) orClauses.push({ branch });
  if (city) {
    orClauses.push({ currentCity: { contains: city, mode: 'insensitive' } });
    orClauses.push({ location: { contains: city, mode: 'insensitive' } });
  }
  if (interests.length > 0) orClauses.push({ interests: { hasSome: interests } });
  if (goals.length > 0) {
    orClauses.push({ user_onboarding: { is: { primaryGoal: { in: goals } } } });
    orClauses.push({ user_goals: { some: { goal: { in: goals } } } });
  }
  orClauses.push(...skillNameClauses(skills));
  if (wantToLearn.length > 0) {
    orClauses.push({ user_onboarding: { is: { canTeach: { hasSome: wantToLearn } } } });
    orClauses.push(...skillNameClauses(wantToLearn));
  }

  if (orClauses.length > 0) {
    andClauses.push({ OR: orClauses });
  }

  return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
}

export function getMatchNotificationCooldownHours(): number {
  return parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_COOLDOWN_HOURS,
    DEFAULT_MATCH_NOTIFICATION_COOLDOWN_HOURS
  );
}

export function getMatchNotificationLookbackDays(): number {
  return parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_LOOKBACK_DAYS,
    DEFAULT_MATCH_LOOKBACK_DAYS
  );
}

export function getMatchNotificationMaxRecipients(): number {
  return parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_MAX_RECIPIENTS,
    DEFAULT_MAX_RECIPIENTS
  );
}

export function getStrongMatchThreshold(): number {
  return parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_MIN_SCORE,
    STRONG_MATCH_THRESHOLD
  );
}

export function isStrongMatch(match: Pick<MatchingScore, 'matchPercentage'>): boolean {
  return match.matchPercentage >= getStrongMatchThreshold();
}

export function buildRecommendedMatchCopy(
  subjectUser: MatchingSignalUser,
  match: Pick<MatchingScore, 'matchPercentage' | 'primaryReason' | 'sharedSignals' | 'whyMatched'>,
  source: MatchNotificationSource,
  now: Date = new Date()
) {
  const subjectName = normalizeText(subjectUser.name) || 'A new builder';
  const freshJoin =
    source === 'signup' ||
    source === 'google_signup' ||
    now.getTime() - new Date(subjectUser.createdAt).getTime() <= RECENT_ACTIVITY_WINDOW_MS;
  const strongestSignal = match.sharedSignals.skills[0] ||
    match.sharedSignals.goals[0] ||
    match.sharedSignals.interests[0] ||
    match.sharedSignals.locationLabel;

  if (match.primaryReason === 'same_college' && match.sharedSignals.locationLabel) {
    return {
      title: freshJoin ? `Someone from ${match.sharedSignals.locationLabel} just joined` : `Strong campus match ready`,
      body: `${subjectName} matches you through ${match.sharedSignals.locationLabel}. ${match.whyMatched.summary}`,
    };
  }

  if (match.primaryReason === 'complementary_skills' && strongestSignal) {
    return {
      title: `${strongestSignal} match on Vormex`,
      body: `${subjectName} is a ${match.matchPercentage}% match. ${match.whyMatched.summary}`,
    };
  }

  if (match.primaryReason === 'shared_skills' && strongestSignal) {
    return {
      title: `${strongestSignal} builder matched`,
      body: `${subjectName} shares skills with you. ${match.whyMatched.summary}`,
    };
  }

  if (match.primaryReason === 'same_goal' && strongestSignal) {
    return {
      title: `${strongestSignal} match available`,
      body: `${subjectName} has the same goal. ${match.whyMatched.summary}`,
    };
  }

  return {
    title: 'New high-quality match',
    body: `${subjectName} is a ${match.matchPercentage}% match. ${match.whyMatched.summary}`,
  };
}

export function serializeMatchedUser(
  user: MatchingSignalUser,
  visibility?: PremiumVisibilityState
) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    profileImage: user.profileImage,
    headline: user.headline,
    verified: Boolean(user.isVerified),
    isVerified: Boolean(user.isVerified),
    profileBadgeStyle: user.profileBadgeStyle ?? null,
    isPremium: Boolean(visibility?.isPremium),
    profileBoostActive: Boolean(visibility?.profileBoostActive),
    profileBoostEndsAt: visibility?.profileBoostEndsAt?.toISOString() || null,
    profileBoostPriority: visibility?.profileBoostPriority || 0,
    discoveryPriority: visibility?.discoveryPriority || 0,
    college: user.college,
    branch: user.branch,
    graduationYear: user.graduationYear,
    interests: user.interests || [],
    bio: user.bio,
    githubConnected: user.githubConnected,
    skills: (user.skills || []).map((entry) => entry.skill.name),
    onboarding: user.user_onboarding
      ? {
          primaryGoal: user.user_onboarding.primaryGoal || null,
          lookingFor: Array.isArray(user.user_onboarding.lookingFor)
            ? user.user_onboarding.lookingFor
            : [],
        }
      : null,
    stats: user.userStats
      ? {
          connectionsCount: user.userStats.connectionsCount,
          xp: user.userStats.xp,
          level: user.userStats.level,
        }
      : null,
  };
}
