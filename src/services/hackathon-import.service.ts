// @ts-nocheck
import axios from 'axios';
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';

type HackathonSource = 'devfolio' | 'mlh';

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

const DEVFOLIO_HACKATHONS_URL = process.env.DEVFOLIO_HACKATHONS_URL || 'https://devfolio.co/hackathons';
const MLH_EVENTS_URL = process.env.MLH_EVENTS_URL || 'https://www.mlh.com/seasons/2026/events';

const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; VormexHackathonImporter/1.0)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
});

function cleanText(value: unknown, max = 280): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanOptionalText(value: unknown, max = 280): string | null {
  const text = cleanText(value, max);
  return text || null;
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

async function upsertExternalHackathon(hackathon: ExternalHackathon): Promise<'created' | 'updated'> {
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
    teamMin: 1,
    teamMax: 4,
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
    return 'updated';
  }

  await prisma.hackathons.create({
    data: {
      ...data,
      slug: await uniqueHackathonSlug(hackathon.title, hackathon.startsAt, hackathon.source),
      createdById: null,
    },
  });

  return 'created';
}

async function importDevfolioHackathons(): Promise<ImportResult> {
  const result: ImportResult = { source: 'devfolio', fetched: 0, imported: 0, created: 0, updated: 0, skipped: 0 };

  try {
    const response = await http.get<string>(DEVFOLIO_HACKATHONS_URL);
    const payload = parseDevfolioPayload(response.data);
    const events = collectDevfolioHackathons(payload);
    result.fetched = events.length;

    for (const event of events) {
      const mapped = mapDevfolioHackathon(event);
      if (!mapped) {
        result.skipped += 1;
        continue;
      }

      const action = await upsertExternalHackathon(mapped);
      result.imported += 1;
      result[action] += 1;
    }
  } catch (error: any) {
    result.error = error?.message || 'Failed to import Devfolio hackathons';
  }

  return result;
}

async function importMlhHackathons(): Promise<ImportResult> {
  const result: ImportResult = { source: 'mlh', fetched: 0, imported: 0, created: 0, updated: 0, skipped: 0 };

  try {
    const response = await http.get<string>(MLH_EVENTS_URL);
    const payload = parseMlhPayload(response.data);
    const events = payload?.props?.upcomingEvents || [];
    result.fetched = events.length;

    for (const event of events) {
      const mapped = mapMlhEvent(event);
      if (!mapped) {
        result.skipped += 1;
        continue;
      }

      const action = await upsertExternalHackathon(mapped);
      result.imported += 1;
      result[action] += 1;
    }
  } catch (error: any) {
    result.error = error?.message || 'Failed to import MLH hackathons';
  }

  return result;
}

export async function importExternalHackathons(options: { sources?: HackathonSource[] } = {}) {
  const requestedSources = options.sources?.length ? options.sources : ['devfolio', 'mlh'];
  const uniqueSources = Array.from(new Set(requestedSources.filter((source) => ['devfolio', 'mlh'].includes(source))));
  const results: ImportResult[] = [];

  for (const source of uniqueSources) {
    if (source === 'devfolio') {
      results.push(await importDevfolioHackathons());
    } else if (source === 'mlh') {
      results.push(await importMlhHackathons());
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
