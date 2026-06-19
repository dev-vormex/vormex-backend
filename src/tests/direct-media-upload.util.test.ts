import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createBunnyStreamUploadIntent,
  createStorageUploadIntent,
  validateFinalizedStreamMedia,
  validateFinalizedStorageMedia,
} from '../utils/direct-media-upload.util';

async function withUploadEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = {
    DIRECT_UPLOAD_TOKEN_SECRET: process.env.DIRECT_UPLOAD_TOKEN_SECRET,
    BUNNY_STREAM_LIBRARY_ID: process.env.BUNNY_STREAM_LIBRARY_ID,
    BUNNY_STREAM_API_KEY: process.env.BUNNY_STREAM_API_KEY,
    BUNNY_STORAGE_ZONE_NAME: process.env.BUNNY_STORAGE_ZONE_NAME,
    BUNNY_STORAGE_API_KEY: process.env.BUNNY_STORAGE_API_KEY,
    BUNNY_STORAGE_HOSTNAME: process.env.BUNNY_STORAGE_HOSTNAME,
    BUNNY_PULL_ZONE_URL: process.env.BUNNY_PULL_ZONE_URL,
  };
  try {
    process.env.DIRECT_UPLOAD_TOKEN_SECRET = 'test-direct-upload-secret';
    process.env.BUNNY_STREAM_LIBRARY_ID = '12345';
    process.env.BUNNY_STREAM_API_KEY = 'stream-api-key';
    process.env.BUNNY_STORAGE_ZONE_NAME = 'vormex-test';
    process.env.BUNNY_STORAGE_API_KEY = 'storage-api-key';
    process.env.BUNNY_STORAGE_HOSTNAME = 'storage.bunnycdn.test';
    process.env.BUNNY_PULL_ZONE_URL = 'https://cdn.example.test';
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('storage upload flow issues a scoped credential', async () => {
  await withUploadEnv(() => {
    const credential = createStorageUploadIntent({
      userId: 'user-1',
      purpose: 'post_media',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
    });

    assert.match(credential.objectKey, /^posts\/images\/user-1-/);
    assert.equal(credential.headers['Content-Type'], 'image/jpeg');
    assert.ok('AccessKey' in credential.headers);
    assert.equal(credential.intent.userId, 'user-1');
    assert.equal(credential.intent.maxBytes, 10 * 1024 * 1024);
  });
});

test('oversized and disallowed storage uploads are rejected at credential issuance', async () => {
  await withUploadEnv(() => {
    assert.throws(
      () => createStorageUploadIntent({
        userId: 'user-1',
        purpose: 'post_media',
        mimeType: 'image/jpeg',
        sizeBytes: 11 * 1024 * 1024,
      }),
      /too large/
    );

    assert.throws(
      () => createStorageUploadIntent({
        userId: 'user-1',
        purpose: 'post_media',
        mimeType: 'application/x-msdownload',
        sizeBytes: 1024,
      }),
      /Unsupported/
    );
  });
});

test('finalize rejects mismatched owner, size, and type before trusting object keys', async () => {
  await withUploadEnv(async () => {
    const credential = createStorageUploadIntent({
      userId: 'user-1',
      purpose: 'post_media',
      mimeType: 'image/png',
      sizeBytes: 2048,
    });

    await assert.rejects(
      validateFinalizedStorageMedia({
        userId: 'user-2',
        token: credential.token,
        objectKey: credential.objectKey,
        mimeType: 'image/png',
        sizeBytes: 2048,
      }),
      /another user/
    );

    await assert.rejects(
      validateFinalizedStorageMedia({
        userId: 'user-1',
        token: credential.token,
        objectKey: credential.objectKey,
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
      }),
      /type mismatch/
    );

    await assert.rejects(
      validateFinalizedStorageMedia({
        userId: 'user-1',
        token: credential.token,
        objectKey: credential.objectKey,
        mimeType: 'image/png',
        sizeBytes: 99 * 1024 * 1024,
      }),
      /size mismatch/
    );
  });
});

test('Bunny Stream credential validates video ownership and size', async () => {
  await withUploadEnv(() => {
    const credential = createBunnyStreamUploadIntent({
      userId: 'user-1',
      videoId: 'video-1',
      mimeType: 'video/mp4',
      sizeBytes: 1_000_000,
    });

    assert.equal(credential.uploadUrl, 'https://video.bunnycdn.com/tusupload');
    assert.equal(credential.headers.VideoId, 'video-1');
    assert.equal(credential.headers.LibraryId, '12345');

    assert.doesNotThrow(() => validateFinalizedStreamMedia({
      userId: 'user-1',
      token: credential.token,
      videoId: 'video-1',
      mimeType: 'video/mp4',
      sizeBytes: 1_000_000,
    }));

    assert.throws(
      () => validateFinalizedStreamMedia({
        userId: 'user-1',
        token: credential.token,
        videoId: 'video-2',
        mimeType: 'video/mp4',
        sizeBytes: 1_000_000,
      }),
      /does not match/
    );
  });
});

test('default post and reel direct-upload routes do not install memory multer before finalize', () => {
  const root = process.cwd();
  const postRoutes = readFileSync(path.join(root, 'src/routes/post.routes.ts'), 'utf8');
  const reelRoutes = readFileSync(path.join(root, 'src/routes/reels.routes.ts'), 'utf8');

  assert.match(postRoutes, /router\.post\('\/upload-url', mediaWriteLimit, getPostUploadUrl\)/);
  assert.match(postRoutes, /router\.post\('\/finalize-upload', mediaWriteLimit, finalizePostUpload\)/);
  assert.doesNotMatch(postRoutes, /router\.post\('\/finalize-upload'[^;]+postUpload/);
  assert.match(postRoutes, /POST_MULTIPART_FALLBACK_MAX_BYTES \|\| 10 \* 1024 \* 1024/);

  assert.match(reelRoutes, /router\.post\('\/upload-url', authenticate, mediaWriteLimit, reelsController\.getUploadUrl\)/);
  assert.match(reelRoutes, /router\.post\('\/upload-complete', authenticate, mediaWriteLimit, reelsController\.onUploadComplete\)/);
  assert.doesNotMatch(reelRoutes, /router\.post\('\/upload-complete'[^;]+uploadWithThumbnail/);
  assert.match(reelRoutes, /REEL_MULTIPART_FALLBACK_MAX_BYTES \|\| 15 \* 1024 \* 1024/);
});
