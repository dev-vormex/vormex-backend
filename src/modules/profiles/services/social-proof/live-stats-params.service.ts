
export /**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SOCIAL PROOF & FOMO SERVICE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Provides social proof features: live stats, profile views, leaderboard,
 * group stats, event stats, activity feed, trending, onboarding.
 * Used by social-proof.controller.ts and cron.service.ts.
 */

interface LiveStatsParams {
    city?: string;
    college?: string;
    userId?: string;
}

export interface LeaderboardParams {
    period: 'daily' | 'weekly' | 'all_time';
    scope: string;
    limit: number;
    userId?: string;
}

export function normalizeCollege(value?: string | null) {
    return value?.trim().toLowerCase() || null;
}

export function startOfToday() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
}

export function daysAgo(days: number) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function pushWeightedTag(
    tags: Map<string, { label: string; weight: number; source: string }>,
    value: unknown,
    source: string,
    weight: number
) {
    if (typeof value !== 'string') return;
    const label = value.trim().replace(/\s+/g, ' ');
    if (!label) return;
    const key = label.toLowerCase();
    const current = tags.get(key);
    tags.set(key, {
        label: current?.label || label,
        weight: (current?.weight || 0) + weight,
        source: current?.source || source,
    });
}

export function formatPercent(value: number) {
    if (!Number.isFinite(value)) return '0%';
    return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function mapProfileInsightPerson(user: any) {
    return {
        id: user.id,
        name: user.name,
        username: user.username,
        profileImage: user.profileImage,
        college: user.college,
        headline: user.headline,
        verified: Boolean(user.isVerified),
        isVerified: Boolean(user.isVerified),
        profileBadgeStyle: user.profileBadgeStyle ?? null,
    };
}
