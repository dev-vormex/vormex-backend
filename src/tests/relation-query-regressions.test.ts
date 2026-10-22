import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { mockPrismaMethod } from './helpers/prisma-mock';
import { controllerRequest, controllerResponse } from './helpers/controller-response';
import { getTrendingAudio, getSavedAudio, getAudioReels } from '../modules/content/controllers/audio.controller';
import { getAvailableBattles } from '../modules/games/controllers/games/battles.controller';
import { getTypingHistory } from '../modules/games/controllers/games/typing.controller';
import { collectOwnedPostMediaUrls } from '../modules/content/controllers/post/support.controller';
import { bunnyStorageService } from '../infrastructure/media/bunny-storage.service';

function assertRelations(modelName: string, include: Record<string, unknown>) {
  const model = Prisma.dmmf.datamodel.models.find((model) => model.name === modelName);
  assert.ok(model);
  const relations = new Set(model.fields.filter((field) => field.kind === 'object').map((field) => field.name));
  for (const name of Object.keys(include)) assert.ok(relations.has(name), `${modelName}.${name} must exist in Prisma`);
}

test('audio listings query actual save relations and preserve isSaved', async (t) => {
  mockPrismaMethod(t, prisma.reel_audio, 'findMany', async (args: { include: Record<string, unknown> }) => {
    assertRelations('reel_audio', args.include);
    return [{ id: 'audio-1', title: 'Track', reel_audio_saves: [{ userId: 'user-1' }] }];
  });
  const { state, response } = controllerResponse();
  await getTrendingAudio(controllerRequest(), response);
  assert.equal(state.status, 200);
  assert.equal((state.body as { audio: { isSaved: boolean }[] }).audio[0].isSaved, true);
});

test('saved audio reads the actual audio relation and returns the public audio shape', async (t) => {
  mockPrismaMethod(t, prisma.reel_audio_saves, 'findMany', async (args: { include: Record<string, unknown> }) => {
    assertRelations('reel_audio_saves', args.include);
    return [
      {
        id: 'save-1',
        reel_audio: { id: 'audio-1', title: 'Track', isActive: true, reel_audio_saves: [{ userId: 'user-1' }] },
      },
    ];
  });
  const { state, response } = controllerResponse();
  await getSavedAudio(controllerRequest(), response);
  assert.equal(state.status, 200);
  const body = state.body as { audio: { id: string; isSaved: boolean }[] };
  assert.equal(body.audio[0].id, 'audio-1');
  assert.equal(body.audio[0].isSaved, true);
});

test('audio reels read the users relation while retaining the author response field', async (t) => {
  mockPrismaMethod(t, prisma.reel_audio, 'findUnique', async () => ({ id: 'audio-1', title: 'Track' }));
  mockPrismaMethod(t, prisma.reels, 'findMany', async (args: { include: Record<string, unknown> }) => {
    assertRelations('reels', args.include);
    return [{ id: 'reel-1', users: { id: 'author-1', name: 'Author' } }];
  });
  const { state, response } = controllerResponse();
  await getAudioReels(controllerRequest({}, {}, { audioId: 'audio-1' }), response);
  assert.equal(state.status, 200);
  assert.deepEqual((state.body as { reels: { author: unknown }[] }).reels[0].author, {
    id: 'author-1',
    name: 'Author',
  });
});

test('quiz battles use Prisma relations and keep the player1 response alias', async (t) => {
  mockPrismaMethod(t, prisma.quiz_battles, 'findMany', async (args: { include: Record<string, unknown> }) => {
    assertRelations('quiz_battles', args.include);
    return [{ id: 'battle-1', users_quiz_battles_player1IdTousers: { id: 'player-1' } }];
  });
  const { state, response } = controllerResponse();
  await getAvailableBattles(controllerRequest(), response);
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, { battles: [{ id: 'battle-1', player1: { id: 'player-1' } }] });
});

test('typing history uses Prisma relations and keeps the text response alias', async (t) => {
  mockPrismaMethod(t, prisma.typing_races, 'findMany', async (args: { include: Record<string, unknown> }) => {
    assertRelations('typing_races', args.include);
    return [{ id: 'race-1', typing_texts: { title: 'Sample' } }];
  });
  const { state, response } = controllerResponse();
  await getTypingHistory(controllerRequest(), response);
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, { races: [{ id: 'race-1', text: { title: 'Sample' } }] });
});

test('post media cleanup parses metadata and excludes assets owned by other users', (t) => {
  t.mock.method(bunnyStorageService, 'isUserOwnedPath', (url: string, userId: string) => url.includes(`/${userId}/`));
  assert.deepEqual(
    collectOwnedPostMediaUrls(
      {
        mediaUrls: ['https://cdn.test/user-1/image.jpg', 'https://cdn.test/user-2/image.jpg'],
        metadata: { videoUrl: 'https://cdn.test/user-1/video.mp4', documentUrl: 'https://cdn.test/user-2/doc.pdf' },
      },
      'user-1'
    ),
    ['https://cdn.test/user-1/image.jpg', 'https://cdn.test/user-1/video.mp4']
  );
});
