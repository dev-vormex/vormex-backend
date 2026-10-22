import { prisma } from "../../../../config/prisma";
import { requestWithBreaker } from "../../../../infrastructure/http/http-client-with-breaker.util";
import { ExternalHackathon, parseDate, cleanList, cleanText, absoluteUrl, cleanOptionalText, inferSkillsFromTags, decodeHtmlAttribute, parseDevpostDateRange, stripHtml, parseUtcDate, clampTeamSize, UpsertHackathonResult, uniqueHackathonSlug, ImportResult, DEVFOLIO_HACKATHONS_URL, hackathonHeaders, parseDevfolioPayload, collectDevfolioHackathons, notifyMatchedUsersAboutNewHackathon, MLH_EVENTS_URL, DEVPOST_MAX_PAGES, DEVPOST_HACKATHONS_API_URL } from "./external-hackathon-sources.service";

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

export function mapHackerEarthHackathon(event: any, now = new Date()): ExternalHackathon | null {
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

export async function upsertExternalHackathon(hackathon: ExternalHackathon): Promise<UpsertHackathonResult> {
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

export async function importDevfolioHackathons(): Promise<ImportResult> {
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

export async function importMlhHackathons(): Promise<ImportResult> {
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

export async function importDevpostHackathons(): Promise<ImportResult> {
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
