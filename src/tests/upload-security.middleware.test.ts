import assert from 'node:assert/strict';
import test from 'node:test';
import { fileNameIsSafe } from '../middleware/upload-security.middleware';

test('upload filenames allow normal camera and generated-image punctuation', () => {
  assert.equal(fileNameIsSafe('ChatGPT Image Jul 16, 2026, 02_50_43 AM.png'), true);
  assert.equal(fileNameIsSafe('profile banner (final).webp'), true);
});

test('upload filenames continue to reject traversal and unsafe characters', () => {
  assert.equal(fileNameIsSafe('../secret.png'), false);
  assert.equal(fileNameIsSafe('banner<script>.png'), false);
  assert.equal(fileNameIsSafe('folder\\banner.png'), false);
});
