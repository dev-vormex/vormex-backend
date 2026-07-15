import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_APP_MIME_TYPE,
  PROFILE_CARDS_HTML,
  PROFILE_CARDS_RESOURCE_URI,
} from '../mcp/profile-cards.widget';

test('profile card widget uses the MCP Apps resource contract', () => {
  assert.equal(MCP_APP_MIME_TYPE, 'text/html;profile=mcp-app');
  assert.equal(PROFILE_CARDS_RESOURCE_URI, 'ui://vormex/profile-cards-v10.html');
  assert.match(PROFILE_CARDS_HTML, /ui\/initialize/);
  assert.match(PROFILE_CARDS_HTML, /ui\/notifications\/tool-result/);
});

test('profile card widget renders profile fields without injecting raw HTML', () => {
  assert.match(PROFILE_CARDS_HTML, /document\.createElement\('img'\)/);
  assert.match(PROFILE_CARDS_HTML, /image\.src = mediaUrl\(profile\.avatar\)/);
  assert.match(PROFILE_CARDS_HTML, /profile\.bannerImage/);
  assert.match(PROFILE_CARDS_HTML, /profile\.connectionsCount/);
  assert.doesNotMatch(PROFILE_CARDS_HTML, /Why this match/i);
  assert.match(PROFILE_CARDS_HTML, /textContent = value/);
  assert.doesNotMatch(PROFILE_CARDS_HTML, /innerHTML/);
  assert.doesNotMatch(PROFILE_CARDS_HTML, /document\.write/);
});

test('profile card widget provides an accessible horizontal carousel', () => {
  assert.match(PROFILE_CARDS_HTML, /scroll-snap-type:\s*x mandatory/);
  assert.match(PROFILE_CARDS_HTML, /scrollbar-width:\s*none/);
  assert.doesNotMatch(PROFILE_CARDS_HTML, /carousel-previous/);
  assert.doesNotMatch(PROFILE_CARDS_HTML, /carousel-next/);
  assert.doesNotMatch(PROFILE_CARDS_HTML, /card-backdrop/);
  assert.match(PROFILE_CARDS_HTML, /profile card carousel/i);
});

test('profile cards keep the original explicit public-profile link behavior', () => {
  assert.doesNotMatch(PROFILE_CARDS_HTML, /<dialog id="profile-detail"/);
  assert.doesNotMatch(PROFILE_CARDS_HTML, /openProfileDetail/);
  assert.match(PROFILE_CARDS_HTML, /link\.href = profile\.profileUrl/);
  assert.match(PROFILE_CARDS_HTML, /link\.target = '_blank'/);
});
