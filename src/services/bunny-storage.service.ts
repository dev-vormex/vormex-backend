import { bunnyConfig } from '../config/bunny.config';
import { requestWithBreaker } from '../utils/http-client-with-breaker.util';

export class BunnyStorageService {
  private baseUrl: string;
  private apiKey: string;
  private cdnUrl: string;

  constructor() {
    const { zoneName, apiKey, hostname } = bunnyConfig.storage;
    this.baseUrl = `https://${hostname}/${zoneName}`;
    this.apiKey = apiKey;
    this.cdnUrl = bunnyConfig.cdn.pullZoneUrl;
  }

  private assertSafeStoragePath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
    if (
      !normalized
      || normalized.includes('..')
      || /[\u0000-\u001f\u007f]/.test(normalized)
      || !/^[a-zA-Z0-9/_.,@ -]+$/.test(normalized)
    ) {
      throw new Error('Invalid storage path');
    }
    return normalized;
  }

  private assertSafeFileName(value: string): string {
    const fileName = value.split(/[\\/]/).pop() || '';
    if (
      !fileName
      || fileName.length > 180
      || fileName.includes('..')
      || /[\u0000-\u001f\u007f]/.test(fileName)
      || !/^[a-zA-Z0-9._@ -]+$/.test(fileName)
    ) {
      throw new Error('Invalid file name');
    }
    return fileName;
  }

  getStoragePath(input: string): string {
    const value = input.trim();
    const cdnPrefix = this.cdnUrl.replace(/\/$/, '') + '/';

    if (value.startsWith(cdnPrefix)) {
      return value.slice(cdnPrefix.length).replace(/^\/+/, '');
    }

    if (/^https?:\/\//i.test(value)) {
      throw new Error('File URL is outside the configured CDN');
    }

    return this.assertSafeStoragePath(value);
  }

  isUserOwnedPath(input: string, userId: string): boolean {
    const filePath = this.getStoragePath(input);
    const userDirectories = [
      `certificates/${userId}/`,
      `projects/${userId}/`,
      `logos/${userId}/`,
      `chat/${userId}/`,
    ];
    const userFilePrefixes = [
      'posts/images/',
      'posts/videos/',
      'reels/thumbnails/',
      'stories/images/',
      'stories/videos/',
    ];

    return userDirectories.some((prefix) => filePath.startsWith(prefix))
      || userFilePrefixes.some((prefix) => filePath.startsWith(`${prefix}${userId}-`));
  }

  // Upload file to Bunny Storage
  async uploadFile(
    buffer: Buffer,
    path: string,
    filename: string,
    contentType = 'application/octet-stream'
  ): Promise<string> {
    try {
      const safePath = this.assertSafeStoragePath(path);
      const safeFileName = this.assertSafeFileName(filename);
      const fullPath = `${safePath}/${safeFileName}`;
      const uploadUrl = `${this.baseUrl}/${fullPath}`;

      // Upload to Bunny Storage via PUT request
      await requestWithBreaker('bunny_storage', 'upload_file', {
        method: 'PUT',
        url: uploadUrl,
        data: buffer,
        headers: {
          'AccessKey': this.apiKey,
          'Content-Type': contentType,
        },
      }, {
        connectTimeoutMs: 5_000,
        requestTimeoutMs: 10_000,
      });

      // Return CDN URL (not storage URL)
      const cdnUrl = `${this.cdnUrl}/${fullPath}`;
      return cdnUrl;
    } catch (error: any) {
      console.error('Bunny upload error:', error.response?.data || error.message);
      throw new Error('Failed to upload image to storage');
    }
  }

  // Delete file from Bunny Storage
  async deleteFile(path: string): Promise<void> {
    try {
      const filePath = this.getStoragePath(path);
      const deleteUrl = `${this.baseUrl}/${filePath}`;

      await requestWithBreaker('bunny_storage', 'delete_file', {
        method: 'DELETE',
        url: deleteUrl,
        headers: {
          'AccessKey': this.apiKey,
        },
      }, {
        connectTimeoutMs: 5_000,
        requestTimeoutMs: 8_000,
      });
    } catch (error: any) {
      console.error('Bunny delete error:', error.response?.data || error.message);
      // Don't throw error if file doesn't exist (404 is OK)
      if (error.response?.status !== 404) {
        throw new Error('Failed to delete image from storage');
      }
    }
  }

  // Upload profile picture (pre-cropped by frontend)
  async uploadProfilePicture(buffer: Buffer, userId: string): Promise<string> {
    const filename = `${userId}-${Date.now()}.webp`;
    return this.uploadFile(buffer, 'profiles/avatars', filename, 'image/webp');
  }

  // Upload banner image (pre-cropped by frontend)
  async uploadBanner(buffer: Buffer, userId: string): Promise<string> {
    const filename = `${userId}-${Date.now()}.webp`;
    return this.uploadFile(buffer, 'profiles/banners', filename, 'image/webp');
  }

  // Upload post image (JPEG/PNG/WebP - keep original format for compatibility)
  async uploadPostImage(buffer: Buffer, userId: string, index: number, mimeType: string): Promise<string> {
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const filename = `${userId}-${Date.now()}-${index}.${ext}`;
    return this.uploadFile(buffer, 'posts/images', filename);
  }

  // Upload post video
  async uploadPostVideo(buffer: Buffer, userId: string, mimeType: string): Promise<string> {
    const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mov') ? 'mov' : 'mp4';
    const filename = `${userId}-${Date.now()}.${ext}`;
    return this.uploadFile(buffer, 'posts/videos', filename);
  }

  // Upload reel thumbnail (custom thumbnail for reels)
  async uploadReelThumbnail(buffer: Buffer, userId: string, mimeType: string): Promise<string> {
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const filename = `${userId}-${Date.now()}-thumb.${ext}`;
    return this.uploadFile(buffer, 'reels/thumbnails', filename);
  }

  // Upload story image
  async uploadStoryImage(buffer: Buffer, userId: string, mimeType: string): Promise<string> {
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const filename = `${userId}-${Date.now()}.${ext}`;
    return this.uploadFile(buffer, 'stories/images', filename);
  }

  // Upload story video
  async uploadStoryVideo(buffer: Buffer, userId: string, mimeType: string): Promise<string> {
    const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mov') ? 'mov' : 'mp4';
    const filename = `${userId}-${Date.now()}.${ext}`;
    return this.uploadFile(buffer, 'stories/videos', filename);
  }

  // Upload group icon (1:1 ratio)
  async uploadGroupIcon(buffer: Buffer, groupId: string): Promise<string> {
    const filename = `${groupId}-${Date.now()}.avif`;
    return this.uploadFile(buffer, 'groups/icons', filename);
  }

  // Upload group cover (4:1 ratio)
  async uploadGroupCover(buffer: Buffer, groupId: string): Promise<string> {
    const filename = `${groupId}-${Date.now()}.avif`;
    return this.uploadFile(buffer, 'groups/covers', filename);
  }
}

export const bunnyStorageService = new BunnyStorageService();
