import { requestWithBreaker } from '../http/http-client-with-breaker.util';

const BUNNY_API_KEY = process.env.BUNNY_STREAM_API_KEY!;
const BUNNY_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;
const BUNNY_CDN_HOSTNAME = process.env.BUNNY_STREAM_CDN_HOSTNAME!;

export interface BunnyVideoInfo {
  guid: string;
  title: string;
  dateUploaded: string;
  views: number;
  isPublic: boolean;
  length: number;
  status: number;
  framerate: number;
  width: number;
  height: number;
  availableResolutions: string;
  thumbnailCount: number;
  encodeProgress: number;
  storageSize: number;
  captions: any[];
  hasMP4Fallback: boolean;
  collectionId: string;
  thumbnailFileName: string;
  averageWatchTime: number;
  totalWatchTime: number;
  category: string;
  chapters: any[];
  moments: any[];
  metaTags: any[];
  transcodingMessages: any[];
}

export interface CreateVideoResponse {
  videoId: string;
  uploadUrl: string;
}

class BunnyStreamService {
  private apiBaseUrl = 'https://video.bunnycdn.com/library';

  private getHeaders() {
    return {
      AccessKey: BUNNY_API_KEY,
      'Content-Type': 'application/json',
    };
  }

  async createVideo(title: string): Promise<CreateVideoResponse> {
    try {
      const response = await requestWithBreaker<any>('bunny_stream', 'create_video', {
        method: 'POST',
        url: `${this.apiBaseUrl}/${BUNNY_LIBRARY_ID}/videos`,
        data: { title },
        headers: this.getHeaders(),
      }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

      return {
        videoId: response.data.guid,
        uploadUrl: `${this.apiBaseUrl}/${BUNNY_LIBRARY_ID}/videos/${response.data.guid}`,
      };
    } catch (error: any) {
      console.error('Bunny Stream create video error:', error.response?.data || error.message);
      throw new Error('Failed to create video in Bunny Stream');
    }
  }

  async getVideo(videoId: string): Promise<BunnyVideoInfo> {
    try {
      const response = await requestWithBreaker<BunnyVideoInfo>('bunny_stream', 'get_video', {
        method: 'GET',
        url: `${this.apiBaseUrl}/${BUNNY_LIBRARY_ID}/videos/${videoId}`,
        headers: this.getHeaders(),
      }, { connectTimeoutMs: 5_000, requestTimeoutMs: 8_000 });
      return response.data;
    } catch (error: any) {
      console.error('Bunny Stream get video error:', error.response?.data || error.message);
      throw new Error('Failed to get video from Bunny Stream');
    }
  }

  async uploadVideo(videoId: string, buffer: Buffer): Promise<void> {
    try {
      await requestWithBreaker('bunny_stream', 'upload_video', {
        method: 'PUT',
        url: `${this.apiBaseUrl}/${BUNNY_LIBRARY_ID}/videos/${videoId}`,
        data: buffer,
        headers: {
          AccessKey: BUNNY_API_KEY,
          'Content-Type': 'application/octet-stream',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }, { connectTimeoutMs: 5_000, requestTimeoutMs: 20_000 });
    } catch (error: any) {
      console.error('Bunny Stream upload error:', error.response?.data || error.message);
      throw new Error('Failed to upload video to Bunny Stream');
    }
  }

  async deleteVideo(videoId: string): Promise<void> {
    try {
      await requestWithBreaker('bunny_stream', 'delete_video', {
        method: 'DELETE',
        url: `${this.apiBaseUrl}/${BUNNY_LIBRARY_ID}/videos/${videoId}`,
        headers: this.getHeaders(),
      }, { connectTimeoutMs: 5_000, requestTimeoutMs: 8_000 });
    } catch (error: any) {
      console.error('Bunny Stream delete error:', error.response?.data || error.message);
      if (error.response?.status !== 404) {
        throw new Error('Failed to delete video from Bunny Stream');
      }
    }
  }

  getHlsUrl(videoId: string): string {
    return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/playlist.m3u8`;
  }

  getThumbnailUrl(videoId: string): string {
    return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/thumbnail.jpg`;
  }

  getPreviewUrl(videoId: string): string {
    return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/preview.webp`;
  }

  getMp4Url(videoId: string, quality: string = '720'): string {
    return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/play_${quality}p.mp4`;
  }

  isVideoReady(status: number): boolean {
    return status === 4;
  }

  isVideoFailed(status: number): boolean {
    return status === 5 || status === 6;
  }

  getStatusString(status: number): 'processing' | 'ready' | 'failed' {
    if (this.isVideoReady(status)) return 'ready';
    if (this.isVideoFailed(status)) return 'failed';
    return 'processing';
  }
}

export const bunnyStreamService = new BunnyStreamService();
