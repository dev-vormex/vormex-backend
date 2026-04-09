import sharp from 'sharp';

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

  // Process banner image (already cropped by frontend)
  // Just resize to 1584x396 (4:1 ratio) and convert to AVIF
  async processBannerImage(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize(1584, 396, {
        fit: 'fill', // Don't crop, just resize to exact dimensions
        withoutEnlargement: false,
      })
      .avif({
        quality: 80,
        effort: 4,
      })
      .toBuffer();
  }

  // Generic image processing
  async processImage(
    buffer: Buffer,
    options: ImageProcessingOptions = {}
  ): Promise<Buffer> {
    const {
      width = 1200,
      height,
      quality = 85,
      format = 'avif',
    } = options;

    let pipeline = sharp(buffer);

    // Resize without cropping (frontend already cropped)
    if (width && height) {
      pipeline = pipeline.resize(width, height, {
        fit: 'fill', // Stretch to exact dimensions
        withoutEnlargement: false,
      });
    } else if (width) {
      pipeline = pipeline.resize(width, null, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Convert to AVIF
    if (format === 'avif') {
      pipeline = pipeline.avif({ quality, effort: 4 });
    } else if (format === 'webp') {
      pipeline = pipeline.webp({ quality });
    } else {
      pipeline = pipeline.jpeg({ quality, progressive: true });
    }

    return pipeline.toBuffer();
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

