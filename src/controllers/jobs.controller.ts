import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import {
  CatalogCompany,
  CatalogJob,
  clampLimit,
  findCompany,
  growthCompanies,
  growthJobs,
  matchesQuery,
  queryText,
  routeParam,
} from '../data/growth-hub.catalog';
import { decorateSurfaceRecommendations } from '../services/surface-recommendation.service';
import { recordAuthoritativeRecommendationOutcome } from '../services/recommendation-platform.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const serializeCompany = (company: CatalogCompany | null = null) => company ? {
  id: company.id,
  name: company.name,
  slug: company.slug,
  logo: company.logo || null,
  location: company.location || null,
  isVerified: company.isVerified,
  website: company.website,
} : null;

const serializeJob = (job: CatalogJob) => ({
  id: job.id,
  slug: job.slug,
  title: job.title,
  description: job.description,
  type: job.type,
  location: job.location,
  isRemote: job.isRemote,
  experienceLevel: job.experienceLevel,
  skills: job.skills,
  company: serializeCompany(findCompany(job.companyId)),
  isFeatured: job.isFeatured,
});

const findJob = (idOrSlug: string | undefined): CatalogJob | null => {
  if (!idOrSlug) return null;
  return growthJobs.find((job) => job.id === idOrSlug || job.slug === idOrSlug) || null;
};

const filteredJobs = (req: Request): CatalogJob[] => {
  const type = queryText(req.query.type);
  const location = queryText(req.query.location);
  const experienceLevel = queryText(req.query.experienceLevel);
  const search = queryText(req.query.search);
  const isRemote = typeof req.query.isRemote === 'string'
    ? req.query.isRemote === 'true' || req.query.isRemote === '1'
    : null;

  return growthJobs.filter((job) => {
    const company = findCompany(job.companyId);
    if (type && job.type.toLowerCase() !== type) return false;
    if (experienceLevel && job.experienceLevel.toLowerCase() !== experienceLevel) return false;
    if (isRemote !== null && job.isRemote !== isRemote) return false;
    if (location && !job.location.toLowerCase().includes(location) && !company?.location?.toLowerCase().includes(location)) {
      return false;
    }
    return matchesQuery(
      [job.title, job.description, job.type, job.location, job.experienceLevel, company?.name, ...(job.skills || [])],
      search
    );
  });
};

const safeCreateMarker = async (input: {
  userId: string;
  type: string;
  sourceId: string;
  description: string;
}) => {
  const idempotencyKey = `${input.userId}:${input.type}:${input.sourceId}`;
  try {
    return await prisma.xp_transactions.upsert({
      where: { idempotencyKey },
      create: {
        userId: input.userId,
        amount: 0,
        type: input.type,
        source: 'jobs',
        sourceId: input.sourceId,
        description: input.description,
        currency: 'XP',
        countsForStreak: false,
        idempotencyKey,
      },
      update: {
        description: input.description,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.xp_transactions.findUnique({ where: { idempotencyKey } });
    }
    throw error;
  }
};

export const getCompanies = async (req: Request, res: Response): Promise<void> => {
  try {
    const search = queryText(req.query.search);
    res.json(
      growthCompanies
        .filter((company) => matchesQuery([company.name, company.location, company.website], search))
        .map((company) => serializeCompany(company))
    );
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
};

export const getCompany = async (req: Request, res: Response): Promise<void> => {
  try {
    const slug = routeParam(req.params.slug);
    const company = growthCompanies.find((item) => item.slug === slug || item.id === slug);
    if (!company) {
      res.status(404).json({ error: 'Company not found' });
      return;
    }
    res.json({
      ...serializeCompany(company),
      jobs: growthJobs.filter((job) => job.companyId === company.id).map(serializeJob),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch company' });
  }
};

export const getJobs = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = clampLimit(req.query.limit, 20, 50);
    res.json(filteredJobs(req).slice(0, limit).map(serializeJob));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
};

export const getRecommendedJobs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = String(req.user?.userId || '');
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const limit = clampLimit(req.query.limit, 20, 50);
    const decorated = await decorateSurfaceRecommendations({
      userId,
      surface: 'JOBS',
      entityType: 'JOB',
      items: filteredJobs(req).map(serializeJob),
      pageSize: limit,
    });
    res.json({
      jobs: decorated.items,
      recommendationSessionId: decorated.recommendationSessionId,
      requestId: decorated.requestId,
      rankerVersion: decorated.rankerVersion,
      experimentVariant: decorated.experimentVariant,
      nextCursor: decorated.recommendationNextCursor,
      hasMore: Boolean(decorated.recommendationNextCursor),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recommended jobs' });
  }
};

export const getJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const job = findJob(routeParam(req.params.slug));
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(serializeJob(job));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch job' });
  }
};

export const getFeaturedJobs = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = clampLimit(req.query.limit, 5, 20);
    res.json(growthJobs.filter((job) => job.isFeatured).slice(0, limit).map(serializeJob));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch featured jobs' });
  }
};

export const getJobTypes = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(Array.from(new Set(growthJobs.map((job) => job.type))).sort());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch job types' });
  }
};

export const applyToJob = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const job = findJob(routeParam(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const marker = await safeCreateMarker({
      userId,
      type: 'job_application',
      sourceId: job.id,
      description: `Applied to ${job.title}`,
    });
    void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'JOB', entityId: job.id, eventType: 'APPLICATION', meaningfulOutcome: true,
    }).catch(() => undefined);

    res.json({
      success: true,
      message: 'Application submitted successfully!',
      application: {
        id: marker?.id || `${userId}:${job.id}`,
        job: serializeJob(job),
        status: 'submitted',
        appliedAt: marker?.createdAt?.toISOString?.() || new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to apply' });
  }
};

export const getMyApplications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rows = await prisma.xp_transactions.findMany({
      where: { userId, type: 'job_application', source: 'jobs' },
      orderBy: { createdAt: 'desc' },
    });

    res.json(rows.map((row) => {
      const job = findJob(row.sourceId || '');
      return {
        id: row.id,
        job: job ? serializeJob(job) : null,
        status: 'submitted',
        appliedAt: row.createdAt.toISOString(),
      };
    }).filter((item) => item.job));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
};

export const saveJob = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const job = findJob(routeParam(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    await safeCreateMarker({
      userId,
      type: 'job_saved',
      sourceId: job.id,
      description: `Saved ${job.title}`,
    });

    res.json({ success: true, message: 'Job saved!', job: serializeJob(job) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save job' });
  }
};

export const unsaveJob = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const job = findJob(routeParam(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    await prisma.xp_transactions.deleteMany({
      where: { userId, type: 'job_saved', source: 'jobs', sourceId: job.id },
    });

    res.json({ success: true, message: 'Job removed from saved' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unsave job' });
  }
};

export const getSavedJobs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rows = await prisma.xp_transactions.findMany({
      where: { userId, type: 'job_saved', source: 'jobs' },
      orderBy: { createdAt: 'desc' },
    });

    res.json(rows
      .map((row) => findJob(row.sourceId || ''))
      .filter((job): job is CatalogJob => Boolean(job))
      .map(serializeJob));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch saved jobs' });
  }
};
