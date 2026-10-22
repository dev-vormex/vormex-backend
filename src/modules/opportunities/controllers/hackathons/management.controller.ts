import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { type HackathonSource, EXTERNAL_HACKATHON_SOURCES, importExternalHackathons, notifyMatchedUsersAboutNewHackathon } from "../../services/hackathon-import.service";
import { prisma } from "../../../../config/prisma";
import { cleanList, EXTERNAL_HACKATHON_SOURCE_SET, cleanText, parseRequiredDate, HACKATHON_SOURCES, uniqueHackathonSlug, cleanOptionalText, parseOptionalDate, formatHackathon } from "./support.controller";

export const importExternalHackathonSources = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const sources = cleanList(req.body?.sources, EXTERNAL_HACKATHON_SOURCES.length, 24)
      .map((source) => source.toLowerCase())
      .filter((source): source is HackathonSource => EXTERNAL_HACKATHON_SOURCE_SET.has(source as HackathonSource));
    const result = await importExternalHackathons({
      sources: sources.length ? sources : undefined,
    });

    res.json(result);
  } catch (error) {
    console.error('importExternalHackathonSources error:', error);
    res.status(500).json({ error: 'Failed to import external hackathons' });
  }
};

export const createHackathon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const title = cleanText(req.body.title, 120);
    const description = cleanText(req.body.description, 2000);
    const startsAt = parseRequiredDate(req.body.startsAt, 'startsAt');
    const endsAt = parseRequiredDate(req.body.endsAt, 'endsAt');
    if (!title || !description) {
      res.status(400).json({ error: 'Title and description are required' });
      return;
    }
    if (endsAt <= startsAt) {
      res.status(400).json({ error: 'endsAt must be after startsAt' });
      return;
    }

    const source = cleanText(req.body.source, 40).toLowerCase();
    const normalizedSource = HACKATHON_SOURCES.has(source) ? source : 'college_fest';
    const teamMin = Math.min(12, Math.max(1, Number(req.body.teamMin) || 1));
    const teamMax = Math.min(12, Math.max(teamMin, Number(req.body.teamMax) || 4));
    const slug = await uniqueHackathonSlug(title, startsAt);

    const hackathon = await prisma.hackathons.create({
      data: {
        slug,
        title,
        organizer: cleanOptionalText(req.body.organizer, 120),
        source: normalizedSource,
        sourceUrl: cleanOptionalText(req.body.sourceUrl, 500),
        sourceId: cleanOptionalText(req.body.sourceId, 120),
        college: cleanOptionalText(req.body.college, 160),
        description,
        theme: cleanOptionalText(req.body.theme, 120),
        location: cleanOptionalText(req.body.location, 160),
        isOnline: Boolean(req.body.isOnline),
        startsAt,
        endsAt,
        registrationDeadline: parseOptionalDate(req.body.registrationDeadline),
        teamMin,
        teamMax,
        prizeSummary: cleanOptionalText(req.body.prizeSummary, 240),
        tags: cleanList(req.body.tags, 16, 48),
        skills: cleanList(req.body.skills, 16, 48),
        bannerUrl: cleanOptionalText(req.body.bannerUrl, 500),
        createdById: userId,
      },
      include: { _count: { select: { teams: true, saves: true } } },
    });

    notifyMatchedUsersAboutNewHackathon(hackathon, { actorId: userId }).catch((notificationError) => {
      console.error('notifyMatchedUsersAboutNewHackathon error:', notificationError);
    });

    res.status(201).json({ hackathon: formatHackathon(hackathon) });
  } catch (error) {
    console.error('createHackathon error:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create hackathon' });
  }
};
