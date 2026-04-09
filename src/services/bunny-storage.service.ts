import axios from 'axios';
import { bunnyConfig } from '../config/bunny.config';

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

  // Upload file to Bunny Storage
  async uploadFile(
    buffer: Buffer,
    path: string,
    filename: string
  ): Promise<string> {
    try {
      const fullPath = `${path}/${filename}`;
      const uploadUrl = `${this.baseUrl}/${fullPath}`;

      // Upload to Bunny Storage via PUT request
      await axios.put(uploadUrl, buffer, {
        headers: {
          'AccessKey': this.apiKey,
          'Content-Type': 'application/octet-stream',
        },
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
      // Extract path from CDN URL if full URL provided
      const filePath = path.replace(this.cdnUrl + '/', '');
      const deleteUrl = `${this.baseUrl}/${filePath}`;

      await axios.delete(deleteUrl, {
        headers: {
          'AccessKey': this.apiKey,
        },
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
    const filename = `${userId}-${Date.now()}.avif`;
    return this.uploadFile(buffer, 'profiles/avatars', filename);
  }

  // Upload banner image (pre-cropped by frontend)
  async uploadBanner(buffer: Buffer, userId: string): Promise<string> {
    const filename = `${userId}-${Date.now()}.avif`;
    return this.uploadFile(buffer, 'profiles/banners', filename);
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

