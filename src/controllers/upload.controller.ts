import { Response } from 'express';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { imageProcessingService } from '../services/image-processing.service';
import { bunnyStorageService } from '../services/bunny-storage.service';
import { prisma } from '../config/prisma';
import { queueNames } from '../infrastructure/queue/queue-names';
import { enqueueOutboxEvent } from '../outbox/service';
import { AuthenticatedRequest } from '../types/auth.types';

const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const CHAT_VIDEO_MAX_BYTES = 150 * 1024 * 1024;
const CHAT_VIDEO_MAX_DURATION_MS = 90_000;

const chatFileExtensionByMimeType: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

function sanitizeChatFileName(fileName: string, mimeType: string): string {
  const baseName = (fileName || 'attachment')
    .split(/[\\/]/)
    .pop()
    ?.trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'attachment';

  if (baseName.includes('.')) {
    return baseName;
  }

  const extension = chatFileExtensionByMimeType[mimeType];
  return extension ? `${baseName}.${extension}` : baseName;
}

function parseOptionalDurationMs(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const durationMs = Number(value);
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
}

// Multer config (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB limit
  },
  fileFilter: (_req, file, cb) => {
    // Accept images only
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

export const uploadMiddleware = upload.single('image');

// Upload profile picture (frontend already cropped to 1:1 ratio)
export const uploadProfilePicture = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    // Validate image size
    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Process: resize to 400x400 + convert to AVIF
    // Frontend already cropped, so we just resize without cropping
    const processedBuffer = await imageProcessingService.processProfilePicture(
      req.file.buffer
    );

    // Upload to Bunny Storage
    const cdnUrl = await bunnyStorageService.uploadProfilePicture(
      processedBuffer,
      userId
    );

    // Update user profile in database
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { profileImage: cdnUrl },
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'profile.avatar.updated',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [`user:${userId}`],
        },
      });

      return updated;
    });

    res.json({
      message: 'Profile picture uploaded successfully',
      avatarUrl: cdnUrl,
      user,
    });
  } catch (error: any) {
    console.error('Upload profile picture error:', error);
    res.status(500).json({ error: 'Failed to upload profile picture' });
  }
};

// Upload banner image (frontend already cropped to 4:1 ratio)
export const uploadBanner = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    // Validate image size
    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Process: resize to 1584x396 (4:1 ratio) + convert to AVIF
    // Frontend already cropped, so we just resize without cropping
    const processedBuffer = await imageProcessingService.processBannerImage(
      req.file.buffer
    );

    // Upload to Bunny Storage
    const cdnUrl = await bunnyStorageService.uploadBanner(
      processedBuffer,
      userId
    );

    // Update user profile in database
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { bannerImageUrl: cdnUrl },
        select: {
          id: true,
          username: true,
          name: true,
          bannerImageUrl: true,
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'profile.banner.updated',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [`user:${userId}`],
        },
      });

      return updated;
    });

    res.json({
      message: 'Banner image uploaded successfully',
      bannerUrl: cdnUrl,
      user,
    });
  } catch (error: any) {
    console.error('Upload banner error:', error);
    res.status(500).json({ error: 'Failed to upload banner image' });
  }
};

// Delete profile picture
export const deleteProfilePicture = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);

    // Get current user to find existing image URL
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { profileImage: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Delete from Bunny Storage if image exists
    if (user.profileImage) {
      try {
        await bunnyStorageService.deleteFile(user.profileImage);
      } catch (error: any) {
        // Log error but continue to update database (image might already be deleted)
        console.warn('Failed to delete image from storage:', error.message);
      }
    }

    // Update user profile - set profileImage to null
    const updatedUser = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { profileImage: null },
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'profile.avatar.deleted',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [`user:${userId}`],
        },
      });

      return updated;
    });

    res.json({
      message: 'Profile picture deleted successfully',
      user: updatedUser,
    });
  } catch (error: any) {
    console.error('Delete profile picture error:', error);
    res.status(500).json({ error: 'Failed to delete profile picture' });
  }
};

// Delete banner image
export const deleteBanner = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);

    // Get current user to find existing image URL
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { bannerImageUrl: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Delete from Bunny Storage if image exists
    if (user.bannerImageUrl) {
      try {
        await bunnyStorageService.deleteFile(user.bannerImageUrl);
      } catch (error: any) {
        // Log error but continue to update database (image might already be deleted)
        console.warn('Failed to delete image from storage:', error.message);
      }
    }

    // Update user profile - set bannerImageUrl to null
    const updatedUser = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { bannerImageUrl: null },
        select: {
          id: true,
          username: true,
          name: true,
          bannerImageUrl: true,
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'profile.banner.deleted',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [`user:${userId}`],
        },
      });

      return updated;
    });

    res.json({
      message: 'Banner image deleted successfully',
      user: updatedUser,
    });
  } catch (error: any) {
    console.error('Delete banner error:', error);
    res.status(500).json({ error: 'Failed to delete banner image' });
  }
};

// Upload certificate image
export const uploadCertificate = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    // Validate image size
    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Process and upload image
    const processedBuffer = await imageProcessingService.processProfilePicture(req.file.buffer);
    const cdnUrl = await bunnyStorageService.uploadFile(
      processedBuffer,
      `certificates/${userId}`,
      `${Date.now()}.avif`
    );

    res.json({
      message: 'Certificate uploaded successfully',
      certificateUrl: cdnUrl,
    });
  } catch (error: any) {
    console.error('Upload certificate error:', error);
    res.status(500).json({ error: 'Failed to upload certificate' });
  }
};

// Upload project image
export const uploadProject = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    // Validate image size
    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Process and upload image
    const processedBuffer = await imageProcessingService.processProfilePicture(req.file.buffer);
    const cdnUrl = await bunnyStorageService.uploadFile(
      processedBuffer,
      `projects/${userId}`,
      `${Date.now()}.avif`
    );

    res.json({
      message: 'Project image uploaded successfully',
      imageUrl: cdnUrl,
    });
  } catch (error: any) {
    console.error('Upload project error:', error);
    res.status(500).json({ error: 'Failed to upload project image' });
  }
};

// Upload logo image
export const uploadLogo = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    // Validate image size
    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Process and upload image
    const processedBuffer = await imageProcessingService.processProfilePicture(req.file.buffer);
    const cdnUrl = await bunnyStorageService.uploadFile(
      processedBuffer,
      `logos/${userId}`,
      `${Date.now()}.avif`
    );

    res.json({
      message: 'Logo uploaded successfully',
      logoUrl: cdnUrl,
    });
  } catch (error: any) {
    console.error('Upload logo error:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
};

// Generic file delete
export const deleteFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { fileUrl } = req.body;

    if (!fileUrl) {
      res.status(400).json({ error: 'File URL is required' });
      return;
    }

    let isOwnedFile = false;
    try {
      isOwnedFile = bunnyStorageService.isUserOwnedPath(String(fileUrl), userId);
    } catch {
      res.status(400).json({ error: 'Invalid file URL' });
      return;
    }

    if (!isOwnedFile) {
      res.status(403).json({ error: 'You can only delete files uploaded by your account' });
      return;
    }

    try {
      await bunnyStorageService.deleteFile(String(fileUrl));
    } catch (error: any) {
      console.warn('Failed to delete file from storage:', error.message);
    }

    res.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error: any) {
    console.error('Delete file error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
};

// Upload chat media
export const uploadChatMedia = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const fileName = sanitizeChatFileName(req.file.originalname, req.file.mimetype);
    const fileSize = req.file.size;
    const mimeType = req.file.mimetype;
    const isVideo = mimeType.startsWith('video/');
    const maxSize = isVideo ? CHAT_VIDEO_MAX_BYTES : CHAT_ATTACHMENT_MAX_BYTES;
    const durationMs = parseOptionalDurationMs(req.body?.durationMs);

    if (fileSize > maxSize) {
      res.status(400).json({
        error: isVideo ? 'Videos must be under 150 MB' : 'File must be under 25 MB',
      });
      return;
    }

    if (isVideo && durationMs !== null && durationMs > CHAT_VIDEO_MAX_DURATION_MS) {
      res.status(400).json({ error: 'Videos must be 90 seconds or less' });
      return;
    }

    // Determine media type
    let mediaType = 'document';
    if (mimeType.startsWith('image/')) {
      mediaType = 'image';
    } else if (isVideo) {
      mediaType = 'video';
    } else if (mimeType.startsWith('audio/')) {
      mediaType = 'audio';
    }

    // Upload to storage
    const cdnUrl = await bunnyStorageService.uploadFile(
      req.file.buffer,
      `chat/${userId}`,
      `${Date.now()}-${randomUUID()}-${fileName}`,
      mimeType
    );

    res.json({
      mediaUrl: cdnUrl,
      fileName,
      fileSize,
      mediaType,
      ...(durationMs !== null ? { durationMs } : {}),
    });
  } catch (error: any) {
    console.error('Upload chat media error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
};
