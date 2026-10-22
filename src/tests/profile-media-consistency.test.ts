import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { imageProcessingService } from '../infrastructure/media/image-processing.service';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

test('profile media writes evict profile caches before returning success', () => {
  const controller = source('src/modules/content/controllers/upload.controller.ts');
  const avatar = controller.slice(
    controller.indexOf('export const uploadProfilePicture'),
    controller.indexOf('// Upload banner image')
  );
  const banner = controller.slice(
    controller.indexOf('export const uploadBanner'),
    controller.indexOf('// Delete profile picture')
  );

  assert.match(controller, /cacheService\.invalidateTags\(`user:\$\{user\.id\}`\)/);
  assert.match(controller, /cacheService\.delPattern\(`profile:\*:\*:\$\{user\.id\}`\)/);
  assert.ok(avatar.indexOf('invalidateProfileMediaCaches(user)') < avatar.indexOf('res.json'));
  assert.ok(banner.indexOf('invalidateProfileMediaCaches(user)') < banner.indexOf('res.json'));
});

test('GitHub sync invalidates cached profile sections before reporting success', () => {
  const service = source('src/infrastructure/github/github.service.ts');
  const userUpdate = service.indexOf('await prisma.user.update', service.indexOf('export async function syncGitHubData'));
  const invalidate = service.indexOf('await cacheService.invalidateTags(`user:${userId}`)', userUpdate);
  const success = service.indexOf('success: true', invalidate);

  assert.ok(userUpdate >= 0);
  assert.ok(invalidate > userUpdate);
  assert.ok(success > invalidate);
});

test('backend preserves the Android banner preview aspect ratio', async () => {
  const input = await sharp({
    create: {
      width: 900,
      height: 300,
      channels: 3,
      background: '#2475a8',
    },
  }).jpeg().toBuffer();

  const output = await imageProcessingService.processProfileBannerWebp(input);
  const metadata = await sharp(output).metadata();

  assert.equal(metadata.width, 1500);
  assert.equal(metadata.height, 500);
  assert.equal(metadata.format, 'webp');
});
