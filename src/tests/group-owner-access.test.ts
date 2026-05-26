import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildGroupInviteUrl,
  canShareGroupInviteLink,
  getEffectiveGroupRole,
  hasGroupRoleAtLeast,
  normalizeInviteLinkVisibility,
  normalizeGroupRole,
} from '../controllers/groups.controller';

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
