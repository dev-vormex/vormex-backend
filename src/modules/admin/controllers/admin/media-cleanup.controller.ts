import { bunnyConfig } from "../../../../config/bunny.config";
import { prisma } from "../../../../config/prisma";
import { bunnyStorageService } from "../../../../infrastructure/media/bunny-storage.service";
import { chunkArray } from "./support.controller";

export const CHAT_CLEAR_CONFIRMATION = 'CLEAR ALL CHATS';

export const GROUP_CHAT_CLEAR_CONFIRMATION = 'CLEAR GROUP CHAT';

export const BUNNY_CDN_BASE_URL = bunnyConfig.cdn.pullZoneUrl.replace(/\/+$/, '');

export const getBunnyStoragePath = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed) && !trimmed.startsWith(BUNNY_CDN_BASE_URL)) {
    return null;
  }
  const storagePath = trimmed.startsWith(BUNNY_CDN_BASE_URL)
    ? trimmed.slice(BUNNY_CDN_BASE_URL.length).replace(/^\/+/, '')
    : trimmed.replace(/^\/+/, '');
  return storagePath || null;
};

export const isBunnyStorageAsset = (value: unknown, allowedPrefixes: string[]): value is string => {
  const storagePath = getBunnyStoragePath(value);
  if (!storagePath) return false;
  return allowedPrefixes.some((prefix) => storagePath.startsWith(prefix));
};

export const isChatUploadUrl = (value: unknown): value is string => {
  return isBunnyStorageAsset(value, ['chat/']);
};

export const isGroupUploadUrl = (value: unknown): value is string => {
  return isBunnyStorageAsset(value, ['groups/icons/', 'groups/covers/']);
};

export const collectChatMediaAssets = async () => {
  const [directMediaRows, groupMediaRows] = await Promise.all([
    prisma.messages.findMany({
      where: { mediaUrl: { not: null } },
      select: { mediaUrl: true, fileSize: true },
    }),
    prisma.group_messages.findMany({
      where: { mediaUrl: { not: null } },
      select: { mediaUrl: true, fileSize: true },
    }),
  ]);

  const assetsByUrl = new Map<string, number>();

  [...directMediaRows, ...groupMediaRows].forEach((row) => {
    if (!isChatUploadUrl(row.mediaUrl)) return;
    const url = row.mediaUrl.trim();
    const size = typeof row.fileSize === 'number' && Number.isFinite(row.fileSize)
      ? Math.max(row.fileSize, 0)
      : 0;
    assetsByUrl.set(url, Math.max(assetsByUrl.get(url) || 0, size));
  });

  return {
    urls: Array.from(assetsByUrl.keys()),
    bytes: Array.from(assetsByUrl.values()).reduce((total, size) => total + size, 0),
    directMediaRows: directMediaRows.length,
    groupMediaRows: groupMediaRows.length,
  };
};

export const collectGroupChatMediaAssets = async (groupId: string) => {
  const mediaRows = await prisma.group_messages.findMany({
    where: { groupId, mediaUrl: { not: null } },
    select: { mediaUrl: true, fileSize: true },
  });

  const assetsByUrl = new Map<string, number>();

  mediaRows.forEach((row) => {
    if (!isChatUploadUrl(row.mediaUrl)) return;
    const url = row.mediaUrl.trim();
    const size = typeof row.fileSize === 'number' && Number.isFinite(row.fileSize)
      ? Math.max(row.fileSize, 0)
      : 0;
    assetsByUrl.set(url, Math.max(assetsByUrl.get(url) || 0, size));
  });

  return {
    urls: Array.from(assetsByUrl.keys()),
    bytes: Array.from(assetsByUrl.values()).reduce((total, size) => total + size, 0),
    mediaRows: mediaRows.length,
  };
};

export const deleteBunnyAssets = async (urls: string[]) => {
  const result = {
    deleted: 0,
    failed: 0,
    failedUrls: [] as string[],
  };

  for (const batch of chunkArray(urls, 10)) {
    const settled = await Promise.allSettled(
      batch.map((url) => bunnyStorageService.deleteFile(url))
    );

    settled.forEach((entry, index) => {
      if (entry.status === 'fulfilled') {
        result.deleted += 1;
      } else {
        result.failed += 1;
        if (result.failedUrls.length < 10) {
          result.failedUrls.push(batch[index]);
        }
      }
    });
  }

  return result;
};
