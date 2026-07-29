import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildGroupInviteUrl,
  buildAnonymousGroupListCacheKey,
  canShareGroupInviteLink,
  getEffectiveGroupRole,
  hasGroupRoleAtLeast,
  normalizeInviteLinkVisibility,
  normalizeGroupRole,
} from '../controllers/groups.controller';

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `${start} not found`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `${end} not found after ${start}`);
  return source.slice(startIndex, endIndex);
}

test('group creator has effective owner access even if membership is missing', () => {
  const group = { creatorId: 'creator-1' };

  assert.equal(normalizeGroupRole('OWNER'), 'owner');
  assert.equal(getEffectiveGroupRole(group, null, 'creator-1'), 'owner');
  assert.equal(hasGroupRoleAtLeast(group, null, 'creator-1', 'admin'), true);
  assert.equal(hasGroupRoleAtLeast(group, null, 'member-1', 'admin'), false);
});

test('group owner backfill migration repairs missing and stale creator memberships', () => {
  const migrationPath = path.join(
    process.cwd(),
    'prisma/migrations/20260520120000_group_owner_access_and_metadata/migration.sql',
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ADD COLUMN IF NOT EXISTS "category"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "rules"/);
  assert.match(sql, /SET "role" = 'owner'/);
  assert.match(sql, /INSERT INTO "group_members"/);
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /SET "memberCount" = member_counts\.member_count/);
});

test('group invite link policy normalizes visibility and role casing', () => {
  const group = { creatorId: 'owner-1', inviteLinkVisibility: 'MEMBERS' };

  assert.equal(normalizeInviteLinkVisibility('members'), 'MEMBERS');
  assert.equal(normalizeInviteLinkVisibility('ADMINS'), 'ADMINS');
  assert.equal(normalizeInviteLinkVisibility('random'), 'ADMINS');
  assert.equal(canShareGroupInviteLink(group, { role: 'MEMBER' }, 'member-1'), true);
  assert.equal(canShareGroupInviteLink({ ...group, inviteLinkVisibility: 'ADMINS' }, { role: 'MEMBER' }, 'member-1'), false);
  assert.equal(canShareGroupInviteLink({ ...group, inviteLinkVisibility: 'ADMINS' }, { role: 'ADMIN' }, 'admin-1'), true);
  assert.equal(canShareGroupInviteLink({ ...group, inviteLinkVisibility: 'ADMINS' }, null, 'owner-1'), true);
  assert.match(buildGroupInviteUrl('grp_test'), /\/groups\/invite\/grp_test$/);
});

test('group invite migration adds link, direct invite, and join request storage', () => {
  const migrationPath = path.join(
    process.cwd(),
    'prisma/migrations/20260520133000_group_invites_and_links/migration.sql',
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ADD COLUMN IF NOT EXISTS "inviteCode"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "inviteLinkVisibility"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "group_invites"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "group_join_requests"/);
  assert.match(sql, /group_invites_groupId_invitedUserId_key/);
  assert.match(sql, /group_join_requests_groupId_requesterId_key/);
});

test('anonymous group list cache keys normalize equivalent searches', () => {
  const first = buildAnonymousGroupListCacheKey({
    page: 1,
    limit: 20,
    search: '  Study   Partners ',
    category: 'Engineering',
    privacy: 'public',
  });
  const second = buildAnonymousGroupListCacheKey({
    page: 1,
    limit: 20,
    search: 'study partners',
    category: 'Engineering',
    privacy: 'PUBLIC',
  });

  assert.equal(first, second);
  assert.notEqual(first, buildAnonymousGroupListCacheKey({ page: 2, limit: 20 }));
});

test('group discovery lists use denormalized counts, read routing, and cache coordination', () => {
  const controller = fs.readFileSync(
    path.join(process.cwd(), 'src/controllers/groups.controller.ts'),
    'utf8',
  );
  const discover = sourceBetween(controller, 'export const discoverGroups', 'export const getUserPendingInvites');
  const list = sourceBetween(controller, 'export const listGroups', 'export const updateGroup');

  assert.match(discover, /prismaRead\.groups\.findMany/);
  assert.match(discover, /memberCount: g\.memberCount/);
  assert.doesNotMatch(discover, /_count/);
  assert.match(list, /prismaRead\.groups\.findMany/);
  assert.match(list, /cacheService\.getOrSet/);
  assert.match(list, /GROUP_LIST_CACHE_TAG/);
  assert.match(list, /memberCount: g\.memberCount/);
  assert.doesNotMatch(list, /_count/);
});

test('group discovery has an index for visibility and popularity ordering', () => {
  const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'prisma/migrations/20260729150000_optimize_group_discovery_indexes/migration.sql'),
    'utf8',
  );

  assert.match(schema, /@@index\(\[isPrivate, memberCount\(sort: Desc\), id\], map: "groups_visibility_members_idx"\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "groups_visibility_members_idx"/);
});
