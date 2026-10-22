import { requestWithBreaker } from "../../../../infrastructure/http/http-client-with-breaker.util";
import { ImportResult, HACKEREARTH_CHALLENGES_URL, hackathonHeaders, notifyMatchedUsersAboutNewHackathon, HackathonSource } from "./external-hackathon-sources.service";
import { mapHackerEarthHackathon, upsertExternalHackathon } from "./map-devfolio-hackathon.service";

export async function importHackerEarthHackathons(): Promise<ImportResult> {
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

export function externalVisibilityWhere(sources: HackathonSource[], status: string, now: Date): any {
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
