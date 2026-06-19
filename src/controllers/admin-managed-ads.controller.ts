// @ts-nocheck
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { bunnyStorageService } from '../services/bunny-storage.service';
import { bunnyStreamService } from '../services/bunny-stream.service';
import {
  invalidateManagedAdCaches,
  isManagedAdCtaAllowed,
} from '../services/managed-ad.service';

interface AuthRequest extends Request {
  user?: { userId: string; sessionId?: string };
}

const AD_STATUSES = new Set(['draft', 'active', 'paused', 'archived']);
const AD_PLACEMENTS = new Set(['feed', 'reels']);
const CTA_KINDS = new Set(['external_url', 'vormex_deeplink']);

function parseJsonData(req: Request): Record<string, any> {
  if (req.body?.data && typeof req.body.data === 'string') {
    try {
      const parsed = JSON.parse(req.body.data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next || null;
}

function parseInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function parseDate(value: unknown): Date | null {
  const raw = trimmed(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parsePlacements(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return Array.from(
    new Set(
      entries
        .map((entry) => String(entry).trim().toLowerCase())
        .filter((entry) => AD_PLACEMENTS.has(entry))
    )
  );
}

function parseTargeting(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function getFiles(req: Request) {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  return {
    feedImage: files?.feedImage?.[0],
    reelsVideo: files?.reelsVideo?.[0],
    reelsThumbnail: files?.reelsThumbnail?.[0],
  };
}

function extensionForMime(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('mp4')) return 'mp4';
  return 'jpg';
}

async function uploadAdImage(file: Express.Multer.File, campaignId: string, role: 'feed' | 'thumbnail') {
  return bunnyStorageService.uploadFile(
    file.buffer,
    'managed-ads/images',
    `${campaignId}-${role}-${Date.now()}.${extensionForMime(file.mimetype)}`,
    file.mimetype || 'image/jpeg'
  );
}

async function uploadAdVideo(file: Express.Multer.File, campaignId: string) {
  const useBunnyStream = Boolean(
    process.env.BUNNY_STREAM_API_KEY &&
      process.env.BUNNY_STREAM_LIBRARY_ID &&
      process.env.BUNNY_STREAM_CDN_HOSTNAME
  );

  if (useBunnyStream) {
    try {
      const created = await bunnyStreamService.createVideo(`managed_ad_${campaignId}_${Date.now()}`);
      await bunnyStreamService.uploadVideo(created.videoId, file.buffer);
      return {
        reelsVideoUrl: bunnyStreamService.getMp4Url(created.videoId),
        reelsHlsUrl: bunnyStreamService.getHlsUrl(created.videoId),
        reelsThumbnailUrl: bunnyStreamService.getThumbnailUrl(created.videoId),
      };
    } catch (error: any) {
      console.warn('Managed ad Bunny Stream upload failed, falling back to storage:', error.message);
    }
  }

  return {
    reelsVideoUrl: await bunnyStorageService.uploadFile(
      file.buffer,
      'managed-ads/videos',
      `${campaignId}-${Date.now()}.${extensionForMime(file.mimetype)}`,
      file.mimetype || 'video/mp4'
    ),
    reelsHlsUrl: null,
    reelsThumbnailUrl: null,
  };
}

function buildCampaignData(input: Record<string, any>, isCreate: boolean) {
  const data: Record<string, any> = {};

  const textFields = [
    'name',
    'sponsorName',
    'ctaText',
    'ctaUrl',
    'feedTitle',
    'feedBody',
    'reelCaption',
  ];
  textFields.forEach((field) => {
    if (input[field] !== undefined) {
      data[field] = trimmed(input[field]);
    }
  });

  if (input.status !== undefined) {
    const status = String(input.status || '').trim().toLowerCase();
    if (!AD_STATUSES.has(status)) {
      throw new Error('Invalid ad status');
    }
    data.status = status;
  } else if (isCreate) {
    data.status = 'draft';
  }

  if (input.placements !== undefined) {
    data.placements = parsePlacements(input.placements);
  } else if (isCreate) {
    data.placements = [];
  }

  if (input.priority !== undefined || isCreate) {
    data.priority = parseInteger(input.priority, 0);
  }

  if (input.frequencyCapPerDay !== undefined || isCreate) {
    data.frequencyCapPerDay = Math.max(1, parseInteger(input.frequencyCapPerDay, 3));
  }

  if (input.startsAt !== undefined) {
    data.startsAt = parseDate(input.startsAt);
  }

  if (input.endsAt !== undefined) {
    data.endsAt = parseDate(input.endsAt);
  }

  if (input.ctaKind !== undefined || input.ctaUrl !== undefined) {
    const ctaKind = trimmed(input.ctaKind) || (trimmed(input.ctaUrl) ? 'external_url' : null);
    if (ctaKind && !CTA_KINDS.has(ctaKind)) {
      throw new Error('Invalid CTA kind');
    }
    data.ctaKind = ctaKind;
  }

  if (input.targeting !== undefined || isCreate) {
    data.targeting = parseTargeting(input.targeting);
  }

  return data;
}

function validateCampaignForSave(campaign: Record<string, any>) {
  if (!campaign.name) throw new Error('Campaign name is required');
  if (!campaign.sponsorName) throw new Error('Sponsor name is required');

  if (campaign.startsAt && campaign.endsAt && new Date(campaign.endsAt).getTime() <= new Date(campaign.startsAt).getTime()) {
    throw new Error('End date must be after start date');
  }

  if (campaign.ctaUrl && !isManagedAdCtaAllowed(campaign.ctaKind, campaign.ctaUrl)) {
    throw new Error('CTA URL is not allowed for the selected CTA kind');
  }

  if (campaign.status === 'active') {
    if (!Array.isArray(campaign.placements) || campaign.placements.length === 0) {
      throw new Error('Active campaigns need at least one placement');
    }
    if (campaign.placements.includes('feed') && !(campaign.feedTitle || campaign.feedBody || campaign.feedImageUrl)) {
      throw new Error('Active feed campaigns need feed creative');
    }
    if (campaign.placements.includes('reels') && !campaign.reelsVideoUrl) {
      throw new Error('Active reels campaigns need a reels video');
    }
  }
}

function serializeCampaign(campaign: any) {
  const impressions = campaign.impressionsCount || 0;
  const clicks = campaign.clicksCount || 0;
  return {
    ...campaign,
    ctr: impressions > 0 ? clicks / impressions : 0,
    createdByAdmin: campaign.createdByAdmin || null,
  };
}

export const getManagedAds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInteger(req.query.page, 1));
    const limit = Math.min(Math.max(1, parseInteger(req.query.limit, 20)), 100);
    const skip = (page - 1) * limit;
    const status = trimmed(req.query.status)?.toLowerCase();
    const placement = trimmed(req.query.placement)?.toLowerCase();
    const search = trimmed(req.query.search);

    const where: any = {};
    if (status && status !== 'all') where.status = status;
    if (placement && AD_PLACEMENTS.has(placement)) where.placements = { has: placement };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sponsorName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [ads, total] = await Promise.all([
      (prisma as any).managedAdCampaign.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ updatedAt: 'desc' }],
        include: {
          createdByAdmin: { select: { id: true, name: true, email: true } },
        },
      }),
      (prisma as any).managedAdCampaign.count({ where }),
    ]);

    res.json({
      ads: ads.map(serializeCampaign),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getManagedAds error:', error);
    res.status(500).json({ error: 'Failed to load ads' });
  }
};

export const getManagedAdById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ad = await (prisma as any).managedAdCampaign.findUnique({
      where: { id: req.params.id },
      include: {
        createdByAdmin: { select: { id: true, name: true, email: true } },
      },
    });
    if (!ad) {
      res.status(404).json({ error: 'Ad campaign not found' });
      return;
    }
    res.json({ ad: serializeCampaign(ad) });
  } catch (error) {
    console.error('getManagedAdById error:', error);
    res.status(500).json({ error: 'Failed to load ad' });
  }
};

export const createManagedAd = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const campaignId = randomUUID();
    const input = parseJsonData(req);
    const files = getFiles(req);
    const data = buildCampaignData(input, true);

    if (files.feedImage) {
      data.feedImageUrl = await uploadAdImage(files.feedImage, campaignId, 'feed');
    }
    if (files.reelsThumbnail) {
      data.reelsThumbnailUrl = await uploadAdImage(files.reelsThumbnail, campaignId, 'thumbnail');
    }
    if (files.reelsVideo) {
      Object.assign(data, await uploadAdVideo(files.reelsVideo, campaignId));
    }

    validateCampaignForSave(data);

    const ad = await (prisma as any).managedAdCampaign.create({
      data: {
        id: campaignId,
        ...data,
        createdByAdminId: req.user?.userId || null,
      },
      include: {
        createdByAdmin: { select: { id: true, name: true, email: true } },
      },
    });

    invalidateManagedAdCaches();
    res.status(201).json({ ad: serializeCampaign(ad) });
  } catch (error: any) {
    console.error('createManagedAd error:', error);
    res.status(400).json({ error: error.message || 'Failed to create ad' });
  }
};

export const updateManagedAd = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const existing = await (prisma as any).managedAdCampaign.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: 'Ad campaign not found' });
      return;
    }

    const input = parseJsonData(req);
    const files = getFiles(req);
    const data = buildCampaignData(input, false);

    if (files.feedImage) {
      data.feedImageUrl = await uploadAdImage(files.feedImage, existing.id, 'feed');
    }
    if (files.reelsThumbnail) {
      data.reelsThumbnailUrl = await uploadAdImage(files.reelsThumbnail, existing.id, 'thumbnail');
    }
    if (files.reelsVideo) {
      Object.assign(data, await uploadAdVideo(files.reelsVideo, existing.id));
    }

    const merged = { ...existing, ...data };
    validateCampaignForSave(merged);

    const ad = await (prisma as any).managedAdCampaign.update({
      where: { id: existing.id },
      data,
      include: {
        createdByAdmin: { select: { id: true, name: true, email: true } },
      },
    });

    invalidateManagedAdCaches();
    res.json({ ad: serializeCampaign(ad) });
  } catch (error: any) {
    console.error('updateManagedAd error:', error);
    res.status(400).json({ error: error.message || 'Failed to update ad' });
  }
};

export const deleteManagedAd = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await (prisma as any).managedAdCampaign.update({
      where: { id: req.params.id },
      data: { status: 'archived' },
    });
    invalidateManagedAdCaches();
    res.json({ message: 'Ad campaign archived' });
  } catch (error) {
    console.error('deleteManagedAd error:', error);
    res.status(500).json({ error: 'Failed to archive ad' });
  }
};

export const getManagedAdAnalytics = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const campaign = await (prisma as any).managedAdCampaign.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        impressionsCount: true,
        clicksCount: true,
      },
    });
    if (!campaign) {
      res.status(404).json({ error: 'Ad campaign not found' });
      return;
    }

    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const [breakdown, recentEvents] = await Promise.all([
      (prisma as any).managedAdEvent.groupBy({
        by: ['eventType', 'placement'],
        where: { campaignId: campaign.id, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      (prisma as any).managedAdEvent.findMany({
        where: { campaignId: campaign.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          eventType: true,
          placement: true,
          slotKey: true,
          sessionId: true,
          createdAt: true,
          user: { select: { id: true, name: true, username: true } },
        },
      }),
    ]);

    res.json({
      campaign: serializeCampaign(campaign),
      breakdown,
      recentEvents,
    });
  } catch (error) {
    console.error('getManagedAdAnalytics error:', error);
    res.status(500).json({ error: 'Failed to load ad analytics' });
  }
};
