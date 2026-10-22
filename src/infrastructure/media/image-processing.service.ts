import sharp from 'sharp';

/**
 * Longest edge kept for feed photos. The widest column any client renders a post
 * image into is roughly 720 CSS pixels, so this leaves a full 2x for high-DPI
 * screens and pinch-to-zoom without storing camera-native resolutions.
 */
const POST_IMAGE_MAX_DIMENSION = 1440;
const POST_IMAGE_QUALITY = 82;

export interface ImageProcessingOptions {
  width?: number;
  height?: number;
  quality?: number;
  format?: 'avif' | 'webp' | 'jpeg';
}

export class ImageProcessingService {
  // Process profile picture (already cropped by frontend)
  // Just resize to 400x400 and convert to AVIF
  async processProfilePicture(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize(400, 400, {
        fit: 'fill', // Don't crop, just resize to exact dimensions
        withoutEnlargement: false, // Allow upscaling if needed
      })
      .avif({
        quality: 85,
        effort: 4, // Balance between speed and compression
      })
      .toBuffer();
  }

  // Android-friendly profile avatar for in-app rendering.
  async processProfileAvatarWebp(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize(400, 400, {
        fit: 'fill',
        withoutEnlargement: false,
      })
      .webp({
        quality: 85,
      })
      .toBuffer();
  }

  // Process banner image (already cropped by frontend)
  // Keep the same 3:1 geometry used by the Android editor and profile surface.
  async processBannerImage(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize(1500, 500, {
        fit: 'fill', // Don't crop, just resize to exact dimensions
        withoutEnlargement: false,
      })
      .avif({
        quality: 80,
        effort: 4,
      })
      .toBuffer();
  }

  // Android-friendly profile banner for in-app rendering.
  async processProfileBannerWebp(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize(1500, 500, {
        fit: 'fill',
        withoutEnlargement: false,
      })
      .webp({
        quality: 82,
      })
      .toBuffer();
  }

  /**
   * Prepare a user-supplied photo for the feed.
   *
   * Unlike avatars and banners, post images were previously stored exactly as
   * uploaded: a modern phone camera produces a 4000px, multi-megabyte JPEG, and
   * every viewer downloaded all of it to fill a column a few hundred pixels
   * wide. Capping the longest edge and re-encoding to WebP removes most of that
   * without a visible quality change.
   *
   * WebP rather than AVIF on purpose — AVIF encoding of a full-size camera photo
   * costs seconds of CPU, and this runs inline on the request that creates the
   * post. Read-time format negotiation is the CDN's job.
   *
   * Returns null when the original should be stored untouched.
   */
  async processPostImage(
    buffer: Buffer,
    mimeType: string
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    // A still pipeline would silently collapse an animation to its first frame.
    if (/gif/i.test(mimeType)) {
      return null;
    }

    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      metadata = await sharp(buffer, { failOn: 'none' }).metadata();
    } catch {
      // Unreadable by sharp: store it as uploaded rather than reject the post.
      return null;
    }

    if ((metadata.pages || 1) > 1) {
      return null;
    }

    const longestEdge = Math.max(metadata.width || 0, metadata.height || 0);

    let processed: Buffer;
    try {
      processed = await sharp(buffer, { failOn: 'none' })
        // Applies the EXIF orientation before metadata is dropped on output.
        // Without this, portrait phone photos are stored rotated.
        .rotate()
        .resize({
          width: POST_IMAGE_MAX_DIMENSION,
          height: POST_IMAGE_MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: POST_IMAGE_QUALITY })
        .toBuffer();
    } catch {
      return null;
    }

    // Re-encoding an already small, already efficient image can make it bigger.
    // Only take the result when it is actually an improvement — but always take
    // it when the source needed downscaling, because the dimensions matter to
    // the client's decode cost even if the bytes came out similar.
    if (longestEdge <= POST_IMAGE_MAX_DIMENSION && processed.length >= buffer.length) {
      return null;
    }

    return { buffer: processed, mimeType: 'image/webp' };
  }

  // Validate image file
  validateImage(buffer: Buffer, maxSizeMB: number = 10): { valid: boolean; error?: string } {
    // Check file size
    const sizeMB = buffer.length / (1024 * 1024);
    if (sizeMB > maxSizeMB) {
      return { valid: false, error: `Image size exceeds ${maxSizeMB}MB limit` };
    }
    return { valid: true };
  }
}

export const imageProcessingService = new ImageProcessingService();
