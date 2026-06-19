import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { bunnyConfig } from '../config/bunny.config';
import { requestWithBreaker } from './http-client-with-breaker.util';

export type DirectUploadPurpose = 'post_media' | 'reel_video' | 'reel_thumbnail';
export type DirectUploadKind = 'storage' | 'bunny_stream';

export interface DirectUploadIntent {
  v: 1;
  kind: DirectUploadKind;
  purpose: DirectUploadPurpose;
  userId: string;
  objectKey?: string;
  videoId?: string;
  mimeType: string;
  maxBytes: number;
  expiresAt: number;
}

export interface FinalizedDirectMedia {
  objectKey?: string;
  videoId?: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  token: string;
}

const DEFAULT_EXPIRES_MS = 10 * 60 * 1000;
export const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const POST_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const REEL_VIDEO_MAX_BYTES = 150 * 1024 * 1024;
export const REEL_THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;

const imageMimeToExtension: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const videoMimeToExtension: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export function getDirectUploadSigningSecret(): string {
  const secret =
    process.env.DIRECT_UPLOAD_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    process.env.ENCRYPTION_KEY;

  if (!secret || secret.length < 16) {
    throw new Error('DIRECT_UPLOAD_TOKEN_SECRET, JWT_SECRET, or ENCRYPTION_KEY must be configured for direct uploads.');
  }

  return secret;
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function decodeBase64Url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function signPayload(payload: string): string {
  return createHmac('sha256', getDirectUploadSigningSecret()).update(payload).digest('base64url');
}

export function signDirectUploadIntent(intent: DirectUploadIntent): string {
  const payload = base64Url(JSON.stringify(intent));
  return `${payload}.${signPayload(payload)}`;
}

export function verifyDirectUploadIntent(token: string): DirectUploadIntent {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) {
    throw new Error('Invalid upload token');
  }

  const expected = signPayload(payload);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new Error('Invalid upload token signature');
  }

  const intent = JSON.parse(decodeBase64Url(payload)) as DirectUploadIntent;
  if (intent.v !== 1 || !intent.userId || !intent.purpose || !intent.kind || !intent.mimeType) {
    throw new Error('Invalid upload token payload');
  }

  if (!Number.isFinite(intent.expiresAt) || intent.expiresAt <= Date.now()) {
    throw new Error('Upload token has expired');
  }

  return intent;
}

function mimeExtension(mimeType: string): string | null {
  return imageMimeToExtension[mimeType] || videoMimeToExtension[mimeType] || null;
}

export function maxBytesForDirectUpload(purpose: DirectUploadPurpose, mimeType: string): number | null {
  if (purpose === 'reel_video') {
    return videoMimeToExtension[mimeType] ? REEL_VIDEO_MAX_BYTES : null;
  }

  if (purpose === 'reel_thumbnail') {
    return imageMimeToExtension[mimeType] ? REEL_THUMBNAIL_MAX_BYTES : null;
  }

  if (imageMimeToExtension[mimeType]) return POST_IMAGE_MAX_BYTES;
  if (videoMimeToExtension[mimeType]) return POST_VIDEO_MAX_BYTES;
  return null;
}

function storagePrefixForPurpose(purpose: DirectUploadPurpose, mimeType: string): string {
  if (purpose === 'reel_thumbnail') return 'reels/thumbnails';
  if (imageMimeToExtension[mimeType]) return 'posts/images';
  return 'posts/videos';
}

function storageUrlForObjectKey(objectKey: string): string {
  const { zoneName, hostname } = bunnyConfig.storage;
  return `https://${hostname}/${zoneName}/${objectKey}`;
}

export function cdnUrlForObjectKey(objectKey: string): string {
  return `${bunnyConfig.cdn.pullZoneUrl.replace(/\/$/, '')}/${objectKey}`;
}

export function assertObjectKeyOwnedByIntent(intent: DirectUploadIntent, objectKey: string): void {
  if (!intent.objectKey || objectKey !== intent.objectKey) {
    throw new Error('Uploaded object does not match the issued credential');
  }

  const expectedPrefix = `${storagePrefixForPurpose(intent.purpose, intent.mimeType)}/${intent.userId}-`;
  if (!objectKey.startsWith(expectedPrefix)) {
    throw new Error('Uploaded object is outside the user upload scope');
  }
}

export function createStorageUploadIntent(params: {
  userId: string;
  purpose: 'post_media' | 'reel_thumbnail';
  mimeType: string;
  sizeBytes: number;
  expiresMs?: number;
}): {
  intent: DirectUploadIntent;
  token: string;
  objectKey: string;
  uploadUrl: string;
  cdnUrl: string;
  headers: Record<string, string>;
} {
  const maxBytes = maxBytesForDirectUpload(params.purpose, params.mimeType);
  const extension = mimeExtension(params.mimeType);
  if (!maxBytes || !extension) {
    throw new Error('Unsupported media type');
  }

  if (!Number.isFinite(params.sizeBytes) || params.sizeBytes <= 0 || params.sizeBytes > maxBytes) {
    throw new Error('Media file is too large');
  }

  const prefix = storagePrefixForPurpose(params.purpose, params.mimeType);
  const objectKey = `${prefix}/${params.userId}-${Date.now()}-${randomUUID()}.${extension}`;
  const intent: DirectUploadIntent = {
    v: 1,
    kind: 'storage',
    purpose: params.purpose,
    userId: params.userId,
    objectKey,
    mimeType: params.mimeType,
    maxBytes,
    expiresAt: Date.now() + (params.expiresMs || DEFAULT_EXPIRES_MS),
  };
  const token = signDirectUploadIntent(intent);
  const accessKey = process.env.BUNNY_STORAGE_UPLOAD_API_KEY || bunnyConfig.storage.apiKey;

  return {
    intent,
    token,
    objectKey,
    uploadUrl: storageUrlForObjectKey(objectKey),
    cdnUrl: cdnUrlForObjectKey(objectKey),
    headers: {
      AccessKey: accessKey,
      'Content-Type': params.mimeType,
      'X-Vormex-Upload-Token': token,
    },
  };
}

export function createBunnyStreamUploadIntent(params: {
  userId: string;
  videoId: string;
  mimeType: string;
  sizeBytes: number;
  expiresMs?: number;
}): {
  intent: DirectUploadIntent;
  token: string;
  uploadUrl: string;
  headers: Record<string, string>;
} {
  const maxBytes = maxBytesForDirectUpload('reel_video', params.mimeType);
  if (!maxBytes) {
    throw new Error('Unsupported reel video type');
  }

  if (!Number.isFinite(params.sizeBytes) || params.sizeBytes <= 0 || params.sizeBytes > maxBytes) {
    throw new Error('Reel video file is too large');
  }

  const expiresAt = Date.now() + (params.expiresMs || DEFAULT_EXPIRES_MS);
  const authorizationExpire = Math.floor(expiresAt / 1000);
  const libraryId = String(process.env.BUNNY_STREAM_LIBRARY_ID || '');
  const apiKey = String(process.env.BUNNY_STREAM_API_KEY || '');
  if (!libraryId || !apiKey) {
    throw new Error('Bunny Stream is not configured');
  }

  const authorizationSignature = createHash('sha256')
    .update(`${libraryId}${apiKey}${authorizationExpire}${params.videoId}`)
    .digest('hex');
  const intent: DirectUploadIntent = {
    v: 1,
    kind: 'bunny_stream',
    purpose: 'reel_video',
    userId: params.userId,
    videoId: params.videoId,
    mimeType: params.mimeType,
    maxBytes,
    expiresAt,
  };
  const token = signDirectUploadIntent(intent);

  return {
    intent,
    token,
    uploadUrl: 'https://video.bunnycdn.com/tusupload',
    headers: {
      AuthorizationSignature: authorizationSignature,
      AuthorizationExpire: String(authorizationExpire),
      VideoId: params.videoId,
      LibraryId: libraryId,
      'X-Vormex-Upload-Token': token,
    },
  };
}

export async function getStorageObjectMetadata(objectKey: string): Promise<{
  sizeBytes: number;
  contentType: string | null;
}> {
  const response = await requestWithBreaker('bunny_storage', 'head_direct_upload', {
    method: 'HEAD',
    url: storageUrlForObjectKey(objectKey),
    headers: {
      AccessKey: bunnyConfig.storage.apiKey,
    },
    validateStatus: (status) => status >= 200 && status < 300,
  }, { connectTimeoutMs: 5_000, requestTimeoutMs: 8_000 });

  return {
    sizeBytes: Number(response.headers['content-length'] || 0),
    contentType: String(response.headers['content-type'] || '').split(';')[0] || null,
  };
}

export async function validateFinalizedStorageMedia(params: {
  userId: string;
  token: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  purpose?: DirectUploadPurpose;
}): Promise<string> {
  const intent = verifyDirectUploadIntent(params.token);
  if (intent.kind !== 'storage') throw new Error('Upload token is not for Bunny Storage');
  if (intent.userId !== params.userId) throw new Error('Upload token belongs to another user');
  if (params.purpose && intent.purpose !== params.purpose) throw new Error('Upload purpose mismatch');
  if (intent.mimeType !== params.mimeType) throw new Error('Uploaded media type mismatch');
  if (params.sizeBytes <= 0 || params.sizeBytes > intent.maxBytes) throw new Error('Uploaded media size mismatch');
  assertObjectKeyOwnedByIntent(intent, params.objectKey);

  const metadata = await getStorageObjectMetadata(params.objectKey);
  if (metadata.sizeBytes > intent.maxBytes) throw new Error('Uploaded media exceeds size limit');
  if (metadata.sizeBytes > 0 && metadata.sizeBytes !== params.sizeBytes) {
    throw new Error('Uploaded media size does not match the finalized size');
  }
  if (metadata.contentType && metadata.contentType !== params.mimeType) {
    throw new Error('Uploaded media content type does not match the issued credential');
  }

  return cdnUrlForObjectKey(params.objectKey);
}

export function validateFinalizedStreamMedia(params: {
  userId: string;
  token: string;
  videoId: string;
  mimeType: string;
  sizeBytes: number;
}): DirectUploadIntent {
  const intent = verifyDirectUploadIntent(params.token);
  if (intent.kind !== 'bunny_stream') throw new Error('Upload token is not for Bunny Stream');
  if (intent.userId !== params.userId) throw new Error('Upload token belongs to another user');
  if (intent.videoId !== params.videoId) throw new Error('Uploaded video does not match the issued credential');
  if (intent.mimeType !== params.mimeType) throw new Error('Uploaded media type mismatch');
  if (params.sizeBytes <= 0 || params.sizeBytes > intent.maxBytes) throw new Error('Uploaded media size mismatch');
  return intent;
}
