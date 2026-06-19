// @ts-nocheck
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { notificationService } from './notification.service';
import { requestWithBreaker } from '../utils/http-client-with-breaker.util';

export type HackathonSource = 'devfolio' | 'mlh' | 'devpost' | 'hackerearth';
export const EXTERNAL_HACKATHON_SOURCES: HackathonSource[] = ['devpost', 'hackerearth', 'devfolio', 'mlh'];

interface ExternalHackathon {
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

interface ImportResult {
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

interface UpsertHackathonResult {
  action: 'created' | 'updated';
  hackathon?: ImportedHackathonNotificationTarget | null;
}

const DEVFOLIO_HACKATHONS_URL = process.env.DEVFOLIO_HACKATHONS_URL || 'https://devfolio.co/hackathons';
const MLH_EVENTS_URL = process.env.MLH_EVENTS_URL || 'https://www.mlh.com/seasons/2026/events';
const DEVPOST_HACKATHONS_API_URL = process.env.DEVPOST_HACKATHONS_API_URL || 'https://devpost.com/api/hackathons';
const DEVPOST_MAX_PAGES = Math.min(25, Math.max(1, Number(process.env.DEVPOST_MAX_PAGES) || 12));
const HACKEREARTH_CHALLENGES_URL =
  process.env.HACKEREARTH_CHALLENGES_URL || 'https://www.hackerearth.com/api/community/challenges/compete/';
const HACKATHON_AUTO_IMPORT_ENABLED = process.env.HACKATHON_AUTO_IMPORT_ENABLED !== 'false';
const HACKATHON_AUTO_IMPORT_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.HACKATHON_AUTO_IMPORT_INTERVAL_MS) || 15 * 60 * 1000
);
const HACKATHON_INSTANT_NOTIFICATIONS_ENABLED = process.env.HACKATHON_INSTANT_NOTIFICATIONS_ENABLED !== 'false';
const HACKATHON_INSTANT_NOTIFICATION_LIMIT = Math.min(
  200,
  Math.max(1, Number(process.env.HACKATHON_INSTANT_NOTIFICATION_LIMIT) || 50)
);
const AUTO_VISIBLE_HACKATHON_SOURCES: HackathonSource[] = ['devpost', 'hackerearth'];

let autoImportPromise: Promise<unknown> | null = null;
let lastAutoImportAttemptAt = 0;

const hackathonHeaders = {
  'User-Agent': 'Mozilla/5.0 (compatible; VormexHackathonImporter/1.0)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function cleanText(value: unknown, max = 280): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanOptionalText(value: unknown, max = 280): string | null {
  const text = cleanText(value, max);
  return text || null;
}

function stripHtml(value: unknown, max = 500): string {
  return decodeHtmlAttribute(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanList(values: unknown[], maxItems = 12): string[] {
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

function parseDate(value: unknown): Date | null {
  const text = cleanText(value, 80);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUtcDate(value: unknown): Date | null {
  const text = cleanText(value, 80);
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text) ? `${text}Z` : text;
  return parseDate(normalized);
}

function parseDevpostDateRange(value: unknown, now = new Date()): { startsAt: Date; endsAt: Date } | null {
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

function clampTeamSize(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(12, Math.max(1, Math.round(numberValue)));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || randomUUID().slice(0, 8);
}

async function uniqueHackathonSlug(title: string, startsAt: Date, source: string): Promise<string> {
  const base = slugify(`${source}-${title}-${startsAt.getUTCFullYear()}`);
  let slug = base;
  let suffix = 2;

  while (await prisma.hackathons.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

function decodeHtmlAttribute(value: string): string {
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

function absoluteUrl(base: string, value?: string | null): string | null {
  const text = cleanText(value, 600);
  if (!text) return null;
  try {
    return new URL(text, base).toString();
  } catch {
    return null;
  }
}

function inferSkillsFromTags(tags: string[]): string[] {
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
  ], 20, 60);

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

function collectDevfolioHackathons(root: any): any[] {
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

function parseDevfolioPayload(html: string): any {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('Devfolio payload not found');
  }

  return JSON.parse(match[1]);
}

function mapDevfolioHackathon(event: any, now = new Date()): ExternalHackathon | null {
  const startsAt = parseDate(event.starts_at || event.startsAt);
  const endsAt = parseDate(event.ends_at || event.endsAt);
  if (!startsAt || !endsAt || endsAt < now) return null;

  const settings = event.settings || {};
  const tags = cleanList((event.themes || []).map((entry: any) => entry?.theme?.name || entry?.name), 10);
  const title = cleanText(event.name, 160);
  if (!title) return null;

  const sourceUrl =
    absoluteUrl('https://devfolio.co', settings.external_apply_url) ||
    absoluteUrl('https://devfolio.co', settings.site) ||
    absoluteUrl('https://devfolio.co', event.slug ? `https://${event.slug}.devfolio.co` : null);
  const participantText = Number(event.participants_count || 0) > 0
    ? `${Number(event.participants_count)} people are participating.`
    : 'Applications are open on Devfolio.';
  const modeText = event.is_online ? 'Online' : 'Offline';

  return {
    source: 'devfolio',
    sourceId: String(event.uuid),
    title,
    organizer: 'Devfolio',
    sourceUrl,
    description: `${modeText} Devfolio hackathon. ${participantText}`.slice(0, 500),
    theme: tags[0] || null,
    location: event.is_online ? 'Online' : cleanOptionalText(event.location || event.city || event.country, 120),
    isOnline: Boolean(event.is_online),
    startsAt,
    endsAt,
    registrationDeadline: parseDate(settings.reg_ends_at),
    tags,
    skills: inferSkillsFromTags(tags),
    bannerUrl: cleanOptionalText(settings.featured_cover_img_v2 || settings.featured_cover_img, 600),
  };
}

function parseMlhPayload(html: string): any {
  const match = html.match(/<div id="app"[^>]*\sdata-page="([^"]+)"/);
  if (!match) {
    throw new Error('MLH payload not found');
  }

  return JSON.parse(decodeHtmlAttribute(match[1]));
}

function mapMlhEvent(event: any, now = new Date()): ExternalHackathon | null {
  const startsAt = parseDate(event.startsAt);
  const endsAt = parseDate(event.endsAt);
  if (!startsAt || !endsAt || endsAt < now) return null;

  const title = cleanText(event.name, 160);
  if (!title) return null;

  const sourceUrl =
    absoluteUrl('https://www.mlh.com', event.websiteUrl) ||
    absoluteUrl('https://www.mlh.com', event.url);
  const tags = cleanList([
    'MLH',
    event.region,
    event.formatType === 'digital' ? 'Online' : 'In-person',
    ...(event.customFields?.underserved_types || []),
  ], 10);
  const location = cleanOptionalText(event.location, 160) || (event.formatType === 'digital' ? 'Online' : null);

  return {
    source: 'mlh',
    sourceId: String(event.id),
    title,
    organizer: 'Major League Hacking',
    sourceUrl,
    description: `${event.dateRange || 'Upcoming'} MLH event${location ? ` in ${location}` : ''}.`.slice(0, 500),
    theme: tags.find((tag) => !['MLH', 'Online', 'In-person'].includes(tag)) || 'MLH',
    location,
    isOnline: event.formatType === 'digital',
    startsAt,
    endsAt,
    registrationDeadline: startsAt,
    tags,
    skills: inferSkillsFromTags([title, ...tags]),
    bannerUrl: cleanOptionalText(event.backgroundUrl || event.logoUrl, 600),
  };
}

function mapDevpostHackathon(event: any, now = new Date()): ExternalHackathon | null {
  const title = cleanText(event.title, 160);
  if (!title) return null;

  const dateRange = parseDevpostDateRange(event.submission_period_dates, now);
  const startsAt = dateRange?.startsAt || now;
  const endsAt = dateRange?.endsAt || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (endsAt < now) return null;

  const location = cleanOptionalText(event.displayed_location?.location, 160);
  const isOnline = Boolean(
    event.displayed_location?.icon === 'globe' ||
    location?.toLowerCase() === 'online' ||
    cleanText(event.challenge_type, 40).toLowerCase() === 'online'
  );
  const tags = cleanList([
    'Devpost',
    event.open_state,
    ...(event.themes || []).map((theme: any) => theme?.name),
  ], 12);
  const prizeSummary = stripHtml(event.prize_amount, 160) || null;
  const registrationCount = Number(event.registrations_count || 0);
  const participantText = registrationCount > 0 ? `${registrationCount.toLocaleString('en-US')} people registered.` : '';
  const prizeText = prizeSummary ? `Prize pool: ${prizeSummary}.` : '';
  const sourceUrl = absoluteUrl('https://devpost.com', event.url);
  const sourceId = cleanText(event.id || sourceUrl || title, 120);

  return {
    source: 'devpost',
    sourceId,
    title,
    organizer: cleanOptionalText(event.organization_name, 120) || 'Devpost',
    sourceUrl,
    description: cleanText(
      [
        `${isOnline ? 'Online' : 'In-person'} Devpost hackathon.`,
        event.submission_period_dates ? `Submissions: ${event.submission_period_dates}.` : null,
        prizeText,
        participantText,
      ].filter(Boolean).join(' '),
      500
    ),
    theme: tags.find((tag) => !['Devpost', 'open', 'upcoming'].includes(tag.toLowerCase())) || null,
    location: location || (isOnline ? 'Online' : null),
    isOnline,
    startsAt,
    endsAt,
    registrationDeadline: endsAt,
    prizeSummary,
    tags,
    skills: inferSkillsFromTags([title, ...tags]),
    bannerUrl: absoluteUrl('https://devpost.com', event.thumbnail_url),
  };
}

function mapHackerEarthHackathon(event: any, now = new Date()): ExternalHackathon | null {
  const type = cleanText(event.type, 80);
  const title = cleanText(event.title, 160);
  if (!title || !/hackathon/i.test(`${type} ${title}`)) return null;

  const startsAt = parseUtcDate(event.start);
  const endsAt = parseUtcDate(event.end);
  if (!startsAt || !endsAt || endsAt < now) return null;

  const sourceUrl = absoluteUrl('https://www.hackerearth.com', event.url);
  const organizer = cleanOptionalText(event.company_name, 120) || 'HackerEarth';
  const minTeam = clampTeamSize(event.min_team_size, 1);
  const maxTeam = Math.max(minTeam, clampTeamSize(event.max_team_size, 4));
  const subscriberCount = Number(event.subscription_count || 0);
  const tags = cleanList([
    'HackerEarth',
    type,
    organizer,
    title.match(/\bAI\b|\bML\b|GenAI|Data|Cloud|Security|Web3|Blockchain|Retail|Hiring/i)?.[0],
  ], 12);

  return {
    source: 'hackerearth',
    sourceId: cleanText(event.slug || sourceUrl || title, 120),
    title,
    organizer,
    sourceUrl,
    description: cleanText(
      [
        `${type || 'Hackathon'} on HackerEarth.`,
        event.start_str && event.end_str ? `${event.start_str} to ${event.end_str}.` : null,
        subscriberCount > 0 ? `${subscriberCount.toLocaleString('en-US')} people subscribed.` : null,
      ].filter(Boolean).join(' '),
      500
    ),
    theme: tags.find((tag) => !['HackerEarth', 'Hackathon'].includes(tag)) || null,
    location: 'Online',
    isOnline: true,
    startsAt,
    endsAt,
    registrationDeadline: startsAt,
    teamMin: minTeam,
    teamMax: maxTeam,
    tags,
    skills: inferSkillsFromTags([title, ...tags]),
    bannerUrl: cleanOptionalText(event.listing_image || event.image_url, 600),
  };
}

const hackathonNotificationSelect = {
  id: true,
  title: true,
  source: true,
  college: true,
  startsAt: true,
  endsAt: true,
  registrationDeadline: true,
  tags: true,
  skills: true,
};

async function upsertExternalHackathon(hackathon: ExternalHackathon): Promise<UpsertHackathonResult> {
  const existing = await prisma.hackathons.findFirst({
    where: {
      source: hackathon.source,
      sourceId: hackathon.sourceId,
    },
    select: { id: true },
  });
  const now = new Date();
  const status = hackathon.startsAt > now ? 'upcoming' : hackathon.endsAt < now ? 'past' : 'active';
  const data = {
    title: hackathon.title,
    organizer: hackathon.organizer,
    source: hackathon.source,
    sourceUrl: hackathon.sourceUrl,
    sourceId: hackathon.sourceId,
    college: hackathon.college || null,
    description: hackathon.description,
    theme: hackathon.theme || null,
    location: hackathon.location || null,
    isOnline: hackathon.isOnline,
    startsAt: hackathon.startsAt,
    endsAt: hackathon.endsAt,
    registrationDeadline: hackathon.registrationDeadline || null,
    teamMin: clampTeamSize(hackathon.teamMin, 1),
    teamMax: Math.max(clampTeamSize(hackathon.teamMin, 1), clampTeamSize(hackathon.teamMax, 4)),
    prizeSummary: hackathon.prizeSummary || null,
    tags: hackathon.tags,
    skills: hackathon.skills,
    bannerUrl: hackathon.bannerUrl || null,
    status,
    isActive: true,
  };

  if (existing) {
    await prisma.hackathons.update({
      where: { id: existing.id },
      data,
    });
    return { action: 'updated' };
  }

  const created = await prisma.hackathons.create({
    data: {
      ...data,
      slug: await uniqueHackathonSlug(hackathon.title, hackathon.startsAt, hackathon.source),
      createdById: null,
    },
    select: hackathonNotificationSelect,
  });

  return { action: 'created', hackathon: created };
}

async function importDevfolioHackathons(): Promise<ImportResult> {
  const result: ImportResult = { source: 'devfolio', fetched: 0, imported: 0, created: 0, updated: 0, skipped: 0 };

  try {
    const response = await requestWithBreaker<string>('hackathon_import', 'devfolio', {
      method: 'GET',
      url: DEVFOLIO_HACKATHONS_URL,
      headers: hackathonHeaders,
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 });
    const payload = parseDevfolioPayload(response.data);
    const events = collectDevfolioHackathons(payload);
    result.fetched = events.length;

    for (const event of events) {
      const mapped = mapDevfolioHackathon(event);
      if (!mapped) {
        result.skipped += 1;
        continue;
      }

      const { action, hackathon } = await upsertExternalHackathon(mapped);
      result.imported += 1;
      result[action] += 1;
      if (action === 'created' && hackathon) {
        await notifyMatchedUsersAboutNewHackathon(hackathon).catch((error) => {
          console.error('notifyMatchedUsersAboutNewHackathon error:', error);
        });
      }
    }
  } catch (error: any) {
    result.error = error?.message || 'Failed to import Devfolio hackathons';
  }

  return result;
}

async function importMlhHackathons(): Promise<ImportResult> {
  const result: ImportResult = { source: 'mlh', fetched: 0, imported: 0, created: 0, updated: 0, skipped: 0 };

  try {
    const response = await requestWithBreaker<string>('hackathon_import', 'mlh', {
      method: 'GET',
      url: MLH_EVENTS_URL,
      headers: hackathonHeaders,
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 });
    const payload = parseMlhPayload(response.data);
    const events = payload?.props?.upcomingEvents || [];
    result.fetched = events.length;

    for (const event of events) {
      const mapped = mapMlhEvent(event);
      if (!mapped) {
        result.skipped += 1;
        continue;
      }

      const { action, hackathon } = await upsertExternalHackathon(mapped);
      result.imported += 1;
      result[action] += 1;
      if (action === 'created' && hackathon) {
        await notifyMatchedUsersAboutNewHackathon(hackathon).catch((error) => {
          console.error('notifyMatchedUsersAboutNewHackathon error:', error);
        });
      }
    }
  } catch (error: any) {
    result.error = error?.message || 'Failed to import MLH hackathons';
  }

  return result;
}

async function importDevpostHackathons(): Promise<ImportResult> {
  const result: ImportResult = { source: 'devpost', fetched: 0, imported: 0, created: 0, updated: 0, skipped: 0 };

  try {
    for (let page = 1; page <= DEVPOST_MAX_PAGES; page += 1) {
      const url = new URL(DEVPOST_HACKATHONS_API_URL);
      url.searchParams.set('page', String(page));
      url.searchParams.append('status[]', 'open');
      url.searchParams.append('status[]', 'upcoming');

      const response = await requestWithBreaker<any>('hackathon_import', 'devpost', {
        method: 'GET',
        url: url.toString(),
        headers: { ...hackathonHeaders, Accept: 'application/json,text/plain,*/*' },
      }, { connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 });
      const events = response.data?.hackathons || [];
      result.fetched += events.length;

      for (const event of events) {
        const mapped = mapDevpostHackathon(event);
        if (!mapped) {
          result.skipped += 1;
          continue;
        }

        const { action, hackathon } = await upsertExternalHackathon(mapped);
        result.imported += 1;
        result[action] += 1;
        if (action === 'created' && hackathon) {
          await notifyMatchedUsersAboutNewHackathon(hackathon).catch((error) => {
            console.error('notifyMatchedUsersAboutNewHackathon error:', error);
          });
        }
      }

      const perPage = Number(response.data?.meta?.per_page || events.length || 0);
      if (!events.length || events.length < perPage) break;
    }
  } catch (error: any) {
    result.error = error?.message || 'Failed to import Devpost hackathons';
  }

  return result;
}

async function importHackerEarthHackathons(): Promise<ImportResult> {
  const result: ImportResult = { source: 'hackerearth', fetched: 0, imported: 0, created: 0, updated: 0, skipped: 0 };

  try {
    const response = await requestWithBreaker<any>('hackathon_import', 'hackerearth', {
      method: 'GET',
      url: HACKEREARTH_CHALLENGES_URL,
      headers: { ...hackathonHeaders, Accept: 'application/json,text/plain,*/*' },
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 });
    const events = response.data?.data || [];
    result.fetched = events.length;

    for (const event of events) {
      const mapped = mapHackerEarthHackathon(event);
      if (!mapped) {
        result.skipped += 1;
        continue;
      }

      const { action, hackathon } = await upsertExternalHackathon(mapped);
      result.imported += 1;
      result[action] += 1;
      if (action === 'created' && hackathon) {
        await notifyMatchedUsersAboutNewHackathon(hackathon).catch((error) => {
          console.error('notifyMatchedUsersAboutNewHackathon error:', error);
        });
      }
    }
  } catch (error: any) {
    result.error = error?.message || 'Failed to import HackerEarth hackathons';
  }

  return result;
}

function externalVisibilityWhere(sources: HackathonSource[], status: string, now: Date): any {
  const where: any = {
    isActive: true,
    source: { in: sources },
  };

  if (status === 'active') {
    where.startsAt = { lte: now };
    where.endsAt = { gte: now };
  } else if (status === 'upcoming') {
    where.startsAt = { gt: now };
  } else {
    where.endsAt = { gte: now };
  }

  return where;
}

export async function ensureExternalHackathonsAvailable(options: { source?: string | null; status?: string; now?: Date } = {}) {
  if (!HACKATHON_AUTO_IMPORT_ENABLED) return;

  const source = cleanText(options.source, 40).toLowerCase();
  const status = cleanText(options.status, 24).toLowerCase();
  if (status === 'past') return;
  if (source && !EXTERNAL_HACKATHON_SOURCES.includes(source as HackathonSource)) return;

  const sources = source
    ? [source as HackathonSource]
    : AUTO_VISIBLE_HACKATHON_SOURCES;
  const now = options.now || new Date();
  const existing = await prisma.hackathons.count({
    where: externalVisibilityWhere(sources, status, now),
  });
  if (existing > 0) return;

  if (autoImportPromise) {
    await autoImportPromise;
    return;
  }

  const currentTime = Date.now();
  if (currentTime - lastAutoImportAttemptAt < HACKATHON_AUTO_IMPORT_INTERVAL_MS) return;
  lastAutoImportAttemptAt = currentTime;

  autoImportPromise = importExternalHackathons({ sources })
    .catch((error) => {
      console.error('ensureExternalHackathonsAvailable error:', error);
    })
    .finally(() => {
      autoImportPromise = null;
    });

  await autoImportPromise;
}

export async function importExternalHackathons(options: { sources?: HackathonSource[] } = {}) {
  const requestedSources = options.sources?.length ? options.sources : EXTERNAL_HACKATHON_SOURCES;
  const uniqueSources = Array.from(new Set(requestedSources.filter((source) => EXTERNAL_HACKATHON_SOURCES.includes(source))));
  const results: ImportResult[] = [];

  for (const source of uniqueSources) {
    if (source === 'devfolio') {
      results.push(await importDevfolioHackathons());
    } else if (source === 'mlh') {
      results.push(await importMlhHackathons());
    } else if (source === 'devpost') {
      results.push(await importDevpostHackathons());
    } else if (source === 'hackerearth') {
      results.push(await importHackerEarthHackathons());
    }
  }

  return {
    importedAt: new Date().toISOString(),
    results,
    totals: results.reduce(
      (totals, item) => ({
        fetched: totals.fetched + item.fetched,
        imported: totals.imported + item.imported,
        created: totals.created + item.created,
        updated: totals.updated + item.updated,
        skipped: totals.skipped + item.skipped,
        failedSources: totals.failedSources + (item.error ? 1 : 0),
      }),
      { fetched: 0, imported: 0, created: 0, updated: 0, skipped: 0, failedSources: 0 }
    ),
  };
}
