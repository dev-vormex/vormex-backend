import { prisma } from "../../../../config/prisma";
import { HACKATHON_AUTO_IMPORT_ENABLED, cleanText, EXTERNAL_HACKATHON_SOURCES, HackathonSource, AUTO_VISIBLE_HACKATHON_SOURCES, autoImportPromise, lastAutoImportAttemptAt, setAutoImportPromise, setLastAutoImportAttemptAt, HACKATHON_AUTO_IMPORT_INTERVAL_MS, ImportResult } from "./external-hackathon-sources.service";
import { externalVisibilityWhere, importHackerEarthHackathons } from "./import-hacker-earth-hackathons.service";
import { importDevfolioHackathons, importMlhHackathons, importDevpostHackathons } from "./map-devfolio-hackathon.service";

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
  setLastAutoImportAttemptAt(currentTime);

  setAutoImportPromise(importExternalHackathons({ sources })
    .catch((error) => {
      console.error('ensureExternalHackathonsAvailable error:', error);
    })
    .finally(() => {
      setAutoImportPromise(null);
    }));

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
