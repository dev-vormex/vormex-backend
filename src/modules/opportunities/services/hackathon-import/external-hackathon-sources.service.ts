import { slugify } from "../../../groups/services/group-slug.service";

import { prisma } from "../../../../config/prisma";
import { notificationService } from "../../../notifications/services/notification.service";

export type HackathonSource = 'devfolio' | 'mlh' | 'devpost' | 'hackerearth';

export const EXTERNAL_HACKATHON_SOURCES: HackathonSource[] = ['devpost', 'hackerearth', 'devfolio', 'mlh'];

export interface ExternalHackathon {
  source: HackathonSource;
  sourceId: string;
  title: string;
  organizer?: string | null;
  sourceUrl?: string | null;
  college?: string | null;
  description: string;
  theme?: string | null;
  location?: string | null;
  isOnline: boolean;
  startsAt: Date;
  endsAt: Date;
  registrationDeadline?: Date | null;
  teamMin?: number | null;
  teamMax?: number | null;
  prizeSummary?: string | null;
  tags: string[];
  skills: string[];
  bannerUrl?: string | null;
}

export interface ImportResult {
  source: HackathonSource;
  fetched: number;
  imported: number;
  created: number;
  updated: number;
  skipped: number;
  error?: string;
}

interface ImportedHackathonNotificationTarget {
  id: string;
  title: string;
  source: string;
  college?: string | null;
  startsAt: Date;
  endsAt: Date;
  registrationDeadline?: Date | null;
  tags: string[];
  skills: string[];
}

export interface UpsertHackathonResult {
  action: 'created' | 'updated';
  hackathon?: ImportedHackathonNotificationTarget | null;
}

export const DEVFOLIO_HACKATHONS_URL = process.env.DEVFOLIO_HACKATHONS_URL || 'https://devfolio.co/hackathons';

export const MLH_EVENTS_URL = process.env.MLH_EVENTS_URL || 'https://www.mlh.com/seasons/2026/events';

export const DEVPOST_HACKATHONS_API_URL = process.env.DEVPOST_HACKATHONS_API_URL || 'https://devpost.com/api/hackathons';

export const DEVPOST_MAX_PAGES = Math.min(25, Math.max(1, Number(process.env.DEVPOST_MAX_PAGES) || 12));

export const HACKEREARTH_CHALLENGES_URL =
  process.env.HACKEREARTH_CHALLENGES_URL || 'https://www.hackerearth.com/api/community/challenges/compete/';

export const HACKATHON_AUTO_IMPORT_ENABLED = process.env.HACKATHON_AUTO_IMPORT_ENABLED !== 'false';

export const HACKATHON_AUTO_IMPORT_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.HACKATHON_AUTO_IMPORT_INTERVAL_MS) || 15 * 60 * 1000
);

const HACKATHON_INSTANT_NOTIFICATIONS_ENABLED = process.env.HACKATHON_INSTANT_NOTIFICATIONS_ENABLED !== 'false';

const HACKATHON_INSTANT_NOTIFICATION_LIMIT = Math.min(
  200,
  Math.max(1, Number(process.env.HACKATHON_INSTANT_NOTIFICATION_LIMIT) || 50)
);

export const AUTO_VISIBLE_HACKATHON_SOURCES: HackathonSource[] = ['devpost', 'hackerearth'];

export let autoImportPromise: Promise<unknown> | null = null;

export let lastAutoImportAttemptAt = 0;

export function setAutoImportPromise(value: Promise<unknown> | null): void {
  autoImportPromise = value;
}

export function setLastAutoImportAttemptAt(value: number): void {
  lastAutoImportAttemptAt = value;
}

export const hackathonHeaders = {
  'User-Agent': 'Mozilla/5.0 (compatible; VormexHackathonImporter/1.0)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export function cleanText(value: unknown, max = 280): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanOptionalText(value: unknown, max = 280): string | null {
  const text = cleanText(value, max);
  return text || null;
}

export function stripHtml(value: unknown, max = 500): string {
  return decodeHtmlAttribute(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function cleanList(values: unknown[], maxItems = 12): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  values.flat().forEach((value) => {
    const text = cleanText(value, 60);
    const key = text.toLowerCase();
    if (text && !seen.has(key)) {
      seen.add(key);
      output.push(text);
    }
  });

  return output.slice(0, maxItems);
}

export function parseDate(value: unknown): Date | null {
  const text = cleanText(value, 80);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseUtcDate(value: unknown): Date | null {
  const text = cleanText(value, 80);
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text) ? `${text}Z` : text;
  return parseDate(normalized);
}

export function parseDevpostDateRange(value: unknown, now = new Date()): { startsAt: Date; endsAt: Date } | null {
  const text = cleanText(value, 120);
  if (!text) return null;

  const [rawStart, rawEnd] = text.split(/\s+[-–]\s+/).map((part) => part?.trim()).filter(Boolean);
  if (!rawStart || !rawEnd) return null;

  const monthPattern = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/i;
  const year = (rawEnd.match(/\b20\d{2}\b/) || rawStart.match(/\b20\d{2}\b/))?.[0] || String(now.getUTCFullYear());
  const startMonth = rawStart.match(monthPattern)?.[0];
  const endHasMonth = monthPattern.test(rawEnd);

  const normalizedStart = /\b20\d{2}\b/.test(rawStart) ? rawStart : `${rawStart}, ${year}`;
  const normalizedEndBase = endHasMonth || !startMonth ? rawEnd : `${startMonth} ${rawEnd}`;
  const normalizedEnd = /\b20\d{2}\b/.test(normalizedEndBase) ? normalizedEndBase : `${normalizedEndBase}, ${year}`;

  const startsAt = parseDate(`${normalizedStart} 00:00:00 UTC`);
  const endsAt = parseDate(`${normalizedEnd} 23:59:59 UTC`);
  if (!startsAt || !endsAt) return null;

  return { startsAt, endsAt };
}

export function clampTeamSize(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(12, Math.max(1, Math.round(numberValue)));
}



export async function uniqueHackathonSlug(title: string, startsAt: Date, source: string): Promise<string> {
  const base = slugify(`${source}-${title}-${startsAt.getUTCFullYear()}`);
  let slug = base;
  let suffix = 2;

  while (await prisma.hackathons.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

export function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export function absoluteUrl(base: string, value?: string | null): string | null {
  const text = cleanText(value, 600);
  if (!text) return null;
  try {
    return new URL(text, base).toString();
  } catch {
    return null;
  }
}

export function inferSkillsFromTags(tags: string[]): string[] {
  const normalized = tags.join(' ').toLowerCase();
  const skills: string[] = [];

  const add = (...items: string[]) => skills.push(...items);
  if (/ai|ml|genai|machine/.test(normalized)) add('AI/ML', 'Machine Learning');
  if (/blockchain|web3|crypto|zk/.test(normalized)) add('Blockchain', 'Web3');
  if (/fintech|finance/.test(normalized)) add('FinTech');
  if (/health|bio/.test(normalized)) add('HealthTech');
  if (/iot|hardware|robotics/.test(normalized)) add('IoT/Hardware');
  if (/design|ux|ui/.test(normalized)) add('Design', 'UI/UX');
  if (/cloud|api|backend/.test(normalized)) add('Backend', 'APIs');
  if (/mobile|android|ios/.test(normalized)) add('Mobile');
  if (/game/.test(normalized)) add('Game Development');

  return cleanList(skills.length ? skills : ['Frontend', 'Backend', 'Design'], 8);
}

export async function notifyMatchedUsersAboutNewHackathon(
  hackathon: ImportedHackathonNotificationTarget,
  options: { actorId?: string | null } = {}
): Promise<number> {
  if (!HACKATHON_INSTANT_NOTIFICATIONS_ENABLED) return 0;
  if (hackathon.endsAt < new Date()) return 0;

  const targetSignals = cleanList([
    ...(hackathon.skills || []),
    ...(hackathon.tags || []),
  ], 20);

  const recipientOrClauses: any[] = [];
  if (targetSignals.length > 0) {
    recipientOrClauses.push(
      {
        skills: {
          some: {
            skill: {
              OR: targetSignals.map((skill) => ({
                name: { equals: skill, mode: 'insensitive' },
              })),
            },
          },
        },
      },
      { interests: { hasSome: targetSignals } },
      { user_onboarding: { is: { canTeach: { hasSome: targetSignals } } } },
      { user_onboarding: { is: { wantToLearn: { hasSome: targetSignals } } } }
    );
  }
  if (hackathon.college) {
    recipientOrClauses.push({ college: { equals: hackathon.college, mode: 'insensitive' } });
  }

  if (recipientOrClauses.length === 0) return 0;

  const candidates = await prisma.user.findMany({
    where: {
      isBanned: false,
      ...(options.actorId ? { id: { not: options.actorId } } : {}),
      OR: recipientOrClauses,
    },
    select: {
      id: true,
      college: true,
    },
    take: Math.max(HACKATHON_INSTANT_NOTIFICATION_LIMIT * 2, HACKATHON_INSTANT_NOTIFICATION_LIMIT),
  });

  const sorted = candidates.sort((a, b) => {
    const aSameCollege = Number(Boolean(a.college && hackathon.college && a.college === hackathon.college));
    const bSameCollege = Number(Boolean(b.college && hackathon.college && b.college === hackathon.college));
    return bSameCollege - aSameCollege;
  });

  const recipients = sorted.slice(0, HACKATHON_INSTANT_NOTIFICATION_LIMIT);
  const sourceLabel = hackathon.source
    .split(/[_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  const results = await Promise.allSettled(recipients.map((recipient) =>
    notificationService.notifyNewHackathonMatch(recipient.id, {
      hackathonId: hackathon.id,
      hackathonTitle: hackathon.title,
      source: sourceLabel,
      skills: targetSignals.slice(0, 4),
      startsAt: hackathon.startsAt,
      deadline: hackathon.registrationDeadline || hackathon.endsAt,
      actorId: options.actorId || null,
    })
  ));

  return results.filter((result) => result.status === 'fulfilled').length;
}

export function collectDevfolioHackathons(root: any): any[] {
  const output: any[] = [];
  const seenIds = new Set<string>();
  const visited = new Set<any>();

  const walk = (value: any) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      const hackathons = value.filter((item) =>
        item &&
        typeof item === 'object' &&
        item.uuid &&
        item.name &&
        (item.starts_at || item.startsAt) &&
        (item.ends_at || item.endsAt)
      );

      if (hackathons.length > 0) {
        hackathons.forEach((hackathon) => {
          const id = String(hackathon.uuid);
          if (!seenIds.has(id)) {
            seenIds.add(id);
            output.push(hackathon);
          }
        });
        return;
      }

      value.forEach(walk);
      return;
    }

    Object.values(value).forEach(walk);
  };

  walk(root);
  return output;
}

export function parseDevfolioPayload(html: string): any {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('Devfolio payload not found');
  }

  return JSON.parse(match[1]);
}
