import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { imageProcessingService } from "../../../../infrastructure/media/image-processing.service";
import { bunnyStorageService } from "../../../../infrastructure/media/bunny-storage.service";
import { Group, normalizeOptionalString, normalizeStringList, mergeCategoryIntoTags, invalidateGroupListCache, generateSlug, mapGroupPrivacy } from "./support.controller";
import { hasGroupRoleAtLeast, mapRoleToEnum, getEffectiveGroupRole } from "./roles.controller";

/**
 * Update a group
 * PUT /api/groups/:groupId
 */
export const updateGroup = async (
  req: AuthenticatedRequest,
  res: Response<Group | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }
    const { name, description, privacy, category, tags, coverImage, iconImage, rules } = req.body;

    const [groupRecord, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!groupRecord) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    if (!hasGroupRoleAtLeast(groupRecord, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to update this group' });
      return;
    }

    const updateData: any = {};
    if (name) updateData.name = name.trim();
    if (description !== undefined) updateData.description = normalizeOptionalString(description);
    if (privacy) updateData.isPrivate = privacy === 'PRIVATE' || privacy === 'SECRET';
    if (category !== undefined) updateData.category = normalizeOptionalString(category);
    if (rules !== undefined) updateData.rules = normalizeStringList(rules);
    if (tags) updateData.tags = mergeCategoryIntoTags(normalizeStringList(tags), updateData.category ?? null);
    if (coverImage) updateData.coverImage = coverImage;
    if (iconImage) updateData.iconImage = iconImage;

    const updateDataWithTimestamp = { ...updateData, updatedAt: new Date() };
    const group = await prisma.groups.update({
      where: { id: groupId },
      data: updateDataWithTimestamp,
    });

    invalidateGroupListCache();
    res.status(200).json({
      id: group.id,
      name: group.name,
      slug: generateSlug(group.name),
      description: group.description,
      coverImage: group.coverImage ?? group.imageUrl,
      iconImage: group.iconImage ?? group.imageUrl,
      privacy: mapGroupPrivacy(group.isPrivate),
      category: group.category,
      tags: group.tags,
      rules: group.rules,
      memberCount: group.memberCount,
      postCount: 0,
      createdAt: group.createdAt.toISOString(),
      isMember: true,
      memberRole: mapRoleToEnum(getEffectiveGroupRole(groupRecord, membership, userId) || 'member'),
    });
  } catch (error) {
    console.error('Error updating group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
};

/**
 * Delete a group
 * DELETE /api/groups/:groupId
 */
export const deleteGroup = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    if (group.creatorId !== userId) {
      res.status(403).json({ error: 'Only the creator can delete this group' });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.deleteMany({ where: { groupId } }),
      prisma.groups.delete({ where: { id: groupId } }),
    ]);

    invalidateGroupListCache();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
};

/**
 * Upload group icon
 * POST /api/groups/:groupId/upload/icon
 */
export const uploadGroupIcon = async (
  req: AuthenticatedRequest,
  res: Response<{ iconUrl: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided' });
      return;
    }
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const rawGroupId = ensureString(req.params.groupId);
    if (!rawGroupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: rawGroupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId: rawGroupId, userId } },
      }),
    ]);
    if (!group || !hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to update this group' });
      return;
    }

    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error ?? 'Invalid image' });
      return;
    }

    const processedBuffer = await imageProcessingService.processProfilePicture(req.file.buffer);
    const cdnUrl = await bunnyStorageService.uploadGroupIcon(processedBuffer, rawGroupId!);

    await prisma.groups.update({
      where: { id: rawGroupId! },
      data: { iconImage: cdnUrl, updatedAt: new Date() },
    });

    invalidateGroupListCache();
    res.json({ iconUrl: cdnUrl });
  } catch (error: any) {
    console.error('Upload group icon error:', error);
    res.status(500).json({ error: 'Failed to upload group icon' });
  }
};

/**
 * Upload group cover
 * POST /api/groups/:groupId/upload/cover
 */
export const uploadGroupCover = async (
  req: AuthenticatedRequest,
  res: Response<{ coverUrl: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided' });
      return;
    }
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const rawGroupId = ensureString(req.params.groupId);
    if (!rawGroupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: rawGroupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId: rawGroupId, userId } },
      }),
    ]);
    if (!group || !hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to update this group' });
      return;
    }

    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error ?? 'Invalid image' });
      return;
    }

    const processedBuffer = await imageProcessingService.processBannerImage(req.file.buffer);
    const cdnUrl = await bunnyStorageService.uploadGroupCover(processedBuffer, rawGroupId!);

    await prisma.groups.update({
      where: { id: rawGroupId! },
      data: { coverImage: cdnUrl, updatedAt: new Date() },
    });

    invalidateGroupListCache();
    res.json({ coverUrl: cdnUrl });
  } catch (error: any) {
    console.error('Upload group cover error:', error);
    res.status(500).json({ error: 'Failed to upload group cover' });
  }
};
