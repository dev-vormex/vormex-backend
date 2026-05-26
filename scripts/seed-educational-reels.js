#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const COUNT = Number(process.argv.find((arg) => arg.startsWith('--count='))?.split('=')[1] || 100);
const DRY_RUN = process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');
const TRUSTED_ONLY = process.argv.includes('--trusted-only');
const SELF_HOSTED = process.argv.includes('--self-hosted');
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const SELF_HOSTED_MEDIA_VERSION =
  process.argv.find((arg) => arg.startsWith('--media-version='))?.split('=')[1]
  || `seed-${Date.now()}`;
const SELF_HOSTED_DURATION_SECONDS = 9;
const REEL_WIDTH = 720;
const REEL_HEIGHT = 1280;

const COMMONS_CATEGORIES = [
  'Videos_of_science_education',
  'Videos_of_physics',
  'Videos_of_chemistry',
  'Videos_of_biology',
  'Videos_of_mathematics',
  'Videos_of_technology',
  'Videos_of_computer_science',
  'Videos_of_engineering',
  'Videos_of_astronomy',
  'Videos_of_Earth_sciences',
];

const TRUSTED_COMMONS_FILES = [
  'STEM explains the world! Science, Technology, Engineering, Mathematics.webm',
  'Complexity Science- 9 Earth Systems Science.webm',
  'Science off the Sphere- 1.21 Legowatts.webm',
  'NASA - Dynamic Earth ujBi9Ba8hqs.webm',
  'Liquid crystals.webm',
  'Cytoplasmic streaming.webm',
  "Cytoplasmic streaming'.webm",
  'CO2 Supercritical state.webm',
  'Deadlocks and the Dining Philosophers Problem.webm',
  'A Star Algorithm.webm',
  'Double slit experiment.webm',
  'Electric Fields and Electric Field Lines.webm',
  'How a Laser Works.webm',
  'How Does an MRI Work-.webm',
  'ATP in Use - HHMI BioInteractive Video.webm',
  'Biogas Digester Animation.webm',
  'A Powerful Solar Flare.webm',
  'Black Hole Waves Simulation.webm',
  'Absorption Line Spectra.webm',
  'Emission Line Spectra.webm',
];

const MICRO_LESSONS = [
  ['Binary search', 'When data is sorted, binary search cuts the remaining search space in half each step. That is why it runs in O(log n).', ['computer-science', 'algorithms', 'coding']],
  ['Database indexes', 'An index is like a lookup table for your database. It speeds reads, but every write must update the index too.', ['databases', 'backend', 'sql']],
  ['HTTP status codes', '2xx means success, 4xx means the client request needs fixing, and 5xx means the server failed while handling it.', ['web-dev', 'api', 'backend']],
  ['Cache invalidation', 'A cache is useful only while it is fresh. Tie cached responses to clear invalidation events whenever data changes.', ['backend', 'performance', 'cache']],
  ['Rate limiting', 'Rate limits protect systems by bounding requests over time. They are product safety rails, not just security features.', ['security', 'backend', 'api']],
  ['Big O intuition', 'Big O describes how work grows as input grows. It ignores tiny constants so you can compare algorithms at scale.', ['algorithms', 'computer-science']],
  ['REST basics', 'A REST endpoint should model a resource. Use methods like GET, POST, PUT, and DELETE to make intent obvious.', ['api', 'backend', 'web-dev']],
  ['SQL joins', 'A join combines rows by relationship. Start with the table you need, then join only the fields the screen actually uses.', ['sql', 'databases']],
  ['Transactions', 'A transaction lets multiple database changes succeed or fail together. Use it when partial updates would corrupt meaning.', ['databases', 'backend']],
  ['Pagination', 'Cursor pagination stays stable as data changes. Page numbers are simple, but cursors are safer for fast-moving feeds.', ['backend', 'feeds', 'databases']],
  ['HLS streaming', 'HLS splits video into small chunks so playback can adapt to network speed without downloading the whole file first.', ['video', 'streaming', 'mobile']],
  ['Memory pressure', 'Mobile video feeds should keep only the current decoder active. Preload nearby sources, not every video frame.', ['android', 'mobile', 'performance']],
  ['Load testing', 'A load test is useful when it measures a real user journey, not just a single endpoint in isolation.', ['testing', 'backend', 'scaling']],
  ['Queue workers', 'Queues move slow work out of the request path. The API can respond quickly while workers process jobs safely.', ['backend', 'queues']],
  ['Webhooks', 'A webhook is a server-to-server notification. Always verify signatures before trusting the payload.', ['api', 'security']],
  ['JWT basics', 'A JWT proves a claim was signed. It is not encrypted by default, so never put secrets inside it.', ['auth', 'security']],
  ['Password hashing', 'Passwords should be hashed with slow algorithms like bcrypt or Argon2. Fast hashes are bad for passwords.', ['auth', 'security']],
  ['OAuth', 'OAuth lets one app authorize another without sharing a password. Redirect URLs and state checks matter a lot.', ['auth', 'security']],
  ['Input validation', 'Validate at the boundary. Clean data before it enters controllers, services, queues, or database writes.', ['security', 'backend']],
  ['Idempotency', 'An idempotent operation can be retried safely. Payment, upload, and webhook flows benefit from idempotency keys.', ['backend', 'systems']],
  ['Git commits', 'A good commit explains one logical change. Small commits make review and rollback much easier.', ['git', 'engineering']],
  ['Pull requests', 'A pull request should answer what changed, why it changed, and how it was verified.', ['git', 'teamwork']],
  ['Unit tests', 'Unit tests pin down small pieces of logic. They are fastest when they avoid network, disk, and real databases.', ['testing', 'quality']],
  ['Integration tests', 'Integration tests check that modules cooperate. Use them around controllers, database calls, and auth boundaries.', ['testing', 'backend']],
  ['Observability', 'Logs tell you what happened, metrics show trends, and traces connect the path across services.', ['observability', 'backend']],
  ['Latency budgets', 'Every screen has a latency budget. Spend it on the work users can see, and defer everything else.', ['performance', 'mobile']],
  ['CDN basics', 'A CDN puts assets closer to users. It is especially helpful for images, videos, and static files.', ['cdn', 'performance']],
  ['Image optimization', 'Serve the smallest image that still looks good. Resize, compress, and cache before users wait.', ['frontend', 'performance']],
  ['Video thumbnails', 'A thumbnail should load before the player buffers. It keeps the feed feeling responsive.', ['mobile', 'video']],
  ['Accessibility', 'Accessible UI is usable UI. Labels, contrast, touch targets, and focus order help everyone.', ['frontend', 'accessibility']],
  ['Compose state', 'In Jetpack Compose, state drives UI. Keep state close to where it changes and stable across recomposition.', ['android', 'compose']],
  ['ViewModel role', 'A ViewModel owns screen state and business actions. It should not be a dumping ground for UI drawing code.', ['android', 'architecture']],
  ['Coroutines', 'Coroutines make async code readable. Always think about cancellation and which dispatcher owns the work.', ['kotlin', 'android']],
  ['Kotlin data classes', 'Data classes are ideal for immutable UI models. Copy changed fields instead of mutating shared objects.', ['kotlin', 'android']],
  ['Network retries', 'Retries help transient failures, but add backoff. Instant retry loops can make outages worse.', ['networking', 'backend']],
  ['Exponential backoff', 'Backoff increases wait time after each failure. It protects both the client and the server.', ['systems', 'networking']],
  ['Feature flags', 'Flags let teams ship code separately from launching behavior. Remove stale flags before they become architecture.', ['product', 'engineering']],
  ['Dark launches', 'A dark launch runs new backend behavior without exposing it to users yet. It is a quiet confidence builder.', ['deployment', 'backend']],
  ['Database migrations', 'Good migrations are reversible in spirit: small, ordered, and safe for old and new app versions.', ['databases', 'deployment']],
  ['Foreign keys', 'Foreign keys keep relationships honest. Use cascading deletes only when child data should truly disappear.', ['databases', 'sql']],
  ['Prisma includes', 'Only include relations the response needs. Over-fetching makes APIs slower and memory heavier.', ['prisma', 'backend']],
  ['N+1 queries', 'N+1 happens when a loop triggers one query per row. Batch or include relations to avoid surprise load.', ['databases', 'backend']],
  ['Search indexes', 'Search speed usually comes from purpose-built indexes. Plain substring scans do not scale gracefully.', ['search', 'databases']],
  ['Redis', 'Redis is great for short-lived shared state like caches, counters, and rate limits.', ['redis', 'backend']],
  ['Push notifications', 'A notification should be useful, timely, and actionable. Otherwise it becomes noise.', ['mobile', 'product']],
  ['Realtime sockets', 'Sockets are useful when data changes faster than a refresh button. Keep reconnect behavior boring and reliable.', ['realtime', 'backend']],
  ['Optimistic UI', 'Optimistic UI updates immediately and rolls back on failure. Use it for likes and saves, not irreversible actions.', ['frontend', 'mobile']],
  ['Feed ranking', 'A feed ranker should balance recency, relevance, and quality. Do not let one signal dominate forever.', ['feeds', 'product']],
  ['Cold starts', 'Cold starts happen when runtime setup delays the first request. Keep startup work lean.', ['backend', 'performance']],
  ['Connection pooling', 'A pool reuses database connections. Too few blocks requests; too many can overwhelm the database.', ['databases', 'scaling']],
  ['TLS', 'TLS encrypts traffic between client and server. It protects data in transit from observers and tampering.', ['security', 'networking']],
  ['CORS', 'CORS is a browser rule, not an auth system. Still validate tokens on the server.', ['web-dev', 'security']],
  ['CSRF', 'CSRF tricks a browser into sending an authenticated request. SameSite cookies and CSRF tokens reduce the risk.', ['security', 'web-dev']],
  ['XSS', 'XSS happens when user content becomes executable code. Escape output and sanitize rich text.', ['security', 'frontend']],
  ['SQL injection', 'Parameterized queries keep data separate from SQL code. Never concatenate user input into queries.', ['security', 'databases']],
  ['Least privilege', 'Give services only the permissions they need. Smaller permissions reduce blast radius.', ['security', 'systems']],
  ['Backups', 'A backup is only real if restore has been tested. Practice restore before an emergency.', ['databases', 'ops']],
  ['SLOs', 'An SLO defines the reliability users can expect. It turns uptime from a wish into an engineering target.', ['reliability', 'ops']],
  ['Error budgets', 'An error budget lets teams balance shipping speed against reliability. Spend it deliberately.', ['reliability', 'product']],
  ['Progressive delivery', 'Roll out gradually so you can catch issues before everyone sees them.', ['deployment', 'reliability']],
  ['Android lifecycle', 'Pause expensive work when screens stop. Release camera, mic, and video resources early.', ['android', 'performance']],
  ['Player pools', 'A player pool should be small. In short-video feeds, one active decoder is usually enough.', ['android', 'video']],
  ['Prefetching', 'Prefetch just ahead of the user. Too little feels slow; too much wastes memory and bandwidth.', ['performance', 'mobile']],
  ['Thumbnails first', 'Load posters before video playback. The eye gets context while the player prepares.', ['mobile', 'video']],
  ['App crashes', 'A crash is a broken promise. Capture logs, find the fatal exception, then reduce the resource spike.', ['debugging', 'mobile']],
  ['OOM errors', 'Out-of-memory crashes often come from too many decoded images, videos, or buffers alive at once.', ['debugging', 'android']],
  ['Heap vs native memory', 'Android media codecs use native memory too. Java heap numbers are only part of the story.', ['android', 'performance']],
  ['Kotlin flows', 'StateFlow is great for UI state because it always has a current value.', ['kotlin', 'android']],
  ['Debounce', 'Debounce waits for input to settle. It is useful for search boxes and mention lookups.', ['frontend', 'performance']],
  ['Throttle', 'Throttle limits how often work can run. It is useful for scroll, resize, and analytics events.', ['performance', 'frontend']],
  ['Analytics events', 'Track meaningful actions, not every tap. Good analytics answer product questions.', ['analytics', 'product']],
  ['Privacy', 'Collect the minimum data needed. Privacy is easier when you never store unnecessary details.', ['privacy', 'security']],
  ['Encryption at rest', 'Encrypt sensitive stored data so a database leak is less damaging.', ['security', 'backend']],
  ['Hashing vs encryption', 'Hashing is one-way verification. Encryption is reversible with a key. Use the right tool.', ['security', 'basics']],
  ['Public keys', 'Public-key crypto lets anyone encrypt or verify, while only private key holders decrypt or sign.', ['security', 'basics']],
  ['DNS', 'DNS maps names to network addresses. Slow DNS can make a fast server feel slow.', ['networking', 'web-dev']],
  ['Load balancers', 'A load balancer spreads traffic across instances and can remove unhealthy servers from rotation.', ['systems', 'scaling']],
  ['Horizontal scaling', 'Horizontal scaling adds more machines. It works best when app instances are stateless.', ['scaling', 'backend']],
  ['Vertical scaling', 'Vertical scaling makes one machine bigger. It is simple, but there is always a ceiling.', ['scaling', 'ops']],
  ['Eventual consistency', 'Eventual consistency means reads may briefly lag writes. Design UI copy and retries with that in mind.', ['systems', 'databases']],
  ['Outbox pattern', 'The outbox pattern stores events with DB changes, then dispatches them reliably later.', ['systems', 'backend']],
  ['Cron jobs', 'Cron is good for scheduled work. Make jobs idempotent so reruns do not duplicate damage.', ['backend', 'ops']],
  ['Schema design', 'A schema should match the questions your app asks most often, not just the objects on the screen.', ['databases', 'architecture']],
  ['API contracts', 'Once mobile apps depend on a field, changing it is a migration. Treat API responses as contracts.', ['api', 'mobile']],
  ['Semantic versioning', 'Version numbers communicate compatibility. Breaking changes deserve a major version bump.', ['engineering', 'release']],
  ['Documentation', 'Docs should explain the why, the how, and the edge cases. Examples make docs come alive.', ['documentation', 'engineering']],
  ['Code reviews', 'Review for correctness first, then maintainability, then style. Bugs before polish.', ['teamwork', 'quality']],
  ['Clean functions', 'A clean function has one job and a clear name. If naming is hard, the function may be doing too much.', ['code-quality', 'engineering']],
  ['Refactoring', 'Refactoring changes structure without changing behavior. Tests make that promise believable.', ['code-quality', 'testing']],
  ['Technical debt', 'Debt is a tradeoff, not a sin. Track it so future teams know what interest they are paying.', ['engineering', 'product']],
  ['System design', 'Start system design with requirements and constraints. Architecture follows the shape of the problem.', ['architecture', 'systems']],
  ['CAP theorem', 'During a network partition, distributed systems must choose between consistency and availability.', ['systems', 'databases']],
  ['Message ordering', 'Distributed messages can arrive late or out of order. Include timestamps, versions, or sequence IDs.', ['systems', 'queues']],
  ['Mobile offline mode', 'Offline mode needs local state, sync rules, and conflict handling. It is more than caching screens.', ['mobile', 'systems']],
  ['Search UX', 'Good search handles typos, empty states, and loading states. Results are only half the feature.', ['product', 'frontend']],
  ['Onboarding', 'Good onboarding gets users to one useful action fast. Teach by doing, not by explaining everything.', ['product', 'ux']],
  ['Retention', 'Retention improves when users repeatedly get value. Notifications cannot fix a weak core loop.', ['product', 'growth']],
  ['Mentorship', 'Good mentorship matches goals, availability, and context. Skill fit alone is not enough.', ['education', 'community']],
  ['Learning projects', 'A project teaches better when it has constraints, feedback, and a visible outcome.', ['education', 'projects']],
  ['Hackathon teams', 'A balanced hackathon team needs builders, designers, storytellers, and someone who keeps scope sane.', ['hackathons', 'teamwork']],
  ['Portfolio proof', 'A strong portfolio shows decisions, tradeoffs, and results. Screenshots alone are not proof.', ['career', 'portfolio']],
  ['Interview practice', 'Practice explaining your reasoning, not just solving the problem. Communication is part of engineering.', ['career', 'interviews']],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'VormexEducationalReelsSeeder/1.0' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function head(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      { method: 'HEAD', headers: { 'User-Agent': 'VormexEducationalReelsSeeder/1.0' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
          resolve(head(new URL(res.headers.location, url).href, depth + 1));
          return;
        }

        resolve({
          statusCode: res.statusCode,
          contentType: String(res.headers['content-type'] || ''),
          contentLength: Number(res.headers['content-length'] || 0),
          finalUrl: url,
        });
      }
    );
    request.setTimeout(8000, () => {
      request.destroy(new Error('HEAD request timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

function decodeFileName(value) {
  try {
    return decodeURIComponent(value).replace(/_/g, ' ');
  } catch {
    return value.replace(/_/g, ' ');
  }
}

function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'educational-reel';
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(value, maxChars, maxLines = 5) {
  const words = String(value).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  return lines.slice(0, maxLines);
}

function commonsFileUrl(fileName, params = '') {
  const normalized = fileName.replace(/ /g, '_');
  return `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(normalized)}${params}`;
}

function commonsPageUrl(fileName) {
  const normalized = fileName.replace(/ /g, '_');
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(normalized)}`;
}

function humanizeFileName(fileName) {
  return fileName
    .replace(/\.(webm|mp4)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

async function collectCommonsVideos() {
  const seen = new Set();
  const files = [];

  for (const category of COMMONS_CATEGORIES) {
    const html = await fetchText(`https://commons.wikimedia.org/wiki/Category:${category}`);
    const matches = html.matchAll(/href="\/wiki\/File:([^"#]+?\.(?:webm|mp4))"/gi);
    for (const match of matches) {
      const fileName = decodeFileName(match[1]);
      const key = fileName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(fileName);
    }
    await sleep(600);
  }

  return files;
}

async function filterPlayableVideos(files, targetCount) {
  const selected = [];
  let lastReported = 0;

  for (let checked = 0; checked < files.length; checked += 1) {
    const fileName = files[checked];
    if (selected.length >= targetCount) break;

    try {
      const info = await head(commonsFileUrl(fileName));
      const isVideo = /^video\/(webm|mp4)/i.test(info.contentType);
      const hasSafeSize = info.contentLength > 0 && info.contentLength <= MAX_VIDEO_BYTES;
      if (info.statusCode === 200 && isVideo && hasSafeSize) {
        selected.push(fileName);
      }
    } catch {
      // Skip unreachable Commons files; the feed should contain only playable media.
    }

    if (selected.length > 0 && selected.length % 25 === 0 && selected.length !== lastReported) {
      lastReported = selected.length;
      console.log(`Selected ${selected.length}/${targetCount} playable Commons videos...`);
    }
    if ((checked + 1) % 100 === 0) {
      console.log(`Checked ${checked + 1}/${files.length} Commons files; selected ${selected.length}.`);
    }
    await sleep(150);
  }

  return selected;
}

function getFfmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return process.env.FFMPEG_PATH || 'ffmpeg';
  }
}

function hostedPalette(index) {
  const palettes = [
    { bg: '#102126', panel: '#17343b', accent: '#49d3c6', text: '#f7fffd', soft: '#b9f3ec' },
    { bg: '#181a2a', panel: '#252846', accent: '#ffcf5a', text: '#fffaf0', soft: '#f4df9a' },
    { bg: '#162015', panel: '#253722', accent: '#88d66c', text: '#f7fff3', soft: '#c6edb4' },
    { bg: '#221823', panel: '#38253a', accent: '#ff8fb1', text: '#fff6fb', soft: '#ffc2d5' },
    { bg: '#101726', panel: '#1c2a45', accent: '#7db7ff', text: '#f5f9ff', soft: '#bfdcff' },
  ];
  return palettes[index % palettes.length];
}

function slideSvg({ title, caption, tags, index, slide }) {
  const palette = hostedPalette(index);
  const titleLines = wrapText(title, 18, 3);
  const captionLines = wrapText(caption, 31, 5);
  const tagLine = tags.slice(0, 4).map((tag) => `#${tag.replace(/[^a-z0-9]/gi, '')}`).join('  ');
  const slideTitle = slide === 1 ? 'Core Idea' : slide === 2 ? 'Why It Matters' : 'Remember';
  const bodyLines = slide === 1
    ? captionLines.slice(0, 3)
    : slide === 2
      ? captionLines.slice(2).concat(captionLines).slice(0, 4)
      : wrapText(`Use this idea when you build, debug, review, or scale real products. ${tagLine}`, 30, 5);

  const text = (lines, y, size, color, weight = 500, gap = Math.round(size * 1.35)) =>
    lines.map((line, lineIndex) =>
      `<text x="360" y="${y + lineIndex * gap}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${xmlEscape(line)}</text>`
    ).join('\n');

  return `
<svg width="${REEL_WIDTH}" height="${REEL_HEIGHT}" viewBox="0 0 ${REEL_WIDTH} ${REEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${REEL_WIDTH}" height="${REEL_HEIGHT}" fill="${palette.bg}"/>
  <circle cx="96" cy="120" r="42" fill="${palette.accent}" opacity="0.22"/>
  <circle cx="636" cy="1110" r="76" fill="${palette.accent}" opacity="0.12"/>
  <rect x="54" y="94" width="612" height="1092" rx="34" fill="${palette.panel}" opacity="0.92"/>
  <rect x="86" y="126" width="548" height="1028" rx="28" fill="${palette.bg}" opacity="0.36"/>
  <text x="360" y="188" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="27" font-weight="700" letter-spacing="2" fill="${palette.accent}">VORMEX EDUCATION</text>
  <text x="360" y="274" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="700" fill="${palette.soft}">${slideTitle}</text>
  ${text(titleLines, 388, 54, palette.text, 800, 66)}
  <rect x="134" y="620" width="452" height="3" rx="2" fill="${palette.accent}" opacity="0.75"/>
  ${text(bodyLines, 728, 32, palette.text, 500, 46)}
  <text x="360" y="1088" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="700" fill="${palette.soft}">${xmlEscape(tagLine)}</text>
  <text x="360" y="1138" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="21" fill="${palette.text}" opacity="0.72">${String(index + 1).padStart(3, '0')} / micro lesson</text>
</svg>`;
}

async function renderSlidePng(lesson, index, slide, outputPath) {
  const [title, caption, tags] = lesson;
  const svg = slideSvg({ title, caption, tags, index, slide });
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

function encodeLessonVideo(slidePaths, outputPath) {
  const ffmpeg = getFfmpegPath();
  const args = [
    '-y',
    '-loop', '1', '-t', '3', '-i', slidePaths[0],
    '-loop', '1', '-t', '3', '-i', slidePaths[1],
    '-loop', '1', '-t', '3', '-i', slidePaths[2],
    '-filter_complex',
    `[0:v]scale=${REEL_WIDTH}:${REEL_HEIGHT},setsar=1,format=yuv420p[v0];` +
      `[1:v]scale=${REEL_WIDTH}:${REEL_HEIGHT},setsar=1,format=yuv420p[v1];` +
      `[2:v]scale=${REEL_WIDTH}:${REEL_HEIGHT},setsar=1,format=yuv420p[v2];` +
      '[v0][v1][v2]concat=n=3:v=1:a=0,fps=30[v]',
    '-map', '[v]',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ];
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${(result.stderr || result.stdout || '').slice(-1200)}`);
  }
}

function uploadToBunnyStorage(buffer, storagePath, contentType) {
  const zoneName = process.env.BUNNY_STORAGE_ZONE_NAME;
  const apiKey = process.env.BUNNY_STORAGE_API_KEY;
  const hostname = process.env.BUNNY_STORAGE_HOSTNAME || 'sg.storage.bunnycdn.com';
  const cdnBase = (process.env.BUNNY_PULL_ZONE_URL || `https://${process.env.BUNNY_CDN_HOSTNAME}`).replace(/\/+$/, '');
  if (!zoneName || !apiKey || !cdnBase) {
    throw new Error('Bunny Storage environment variables are required for --self-hosted');
  }

  const normalizedPath = storagePath.replace(/^\/+/, '');
  const uploadUrl = new URL(`https://${hostname}/${zoneName}/${normalizedPath}`);
  return new Promise((resolve, reject) => {
    const request = https.request(
      uploadUrl,
      {
        method: 'PUT',
        headers: {
          AccessKey: apiKey,
          'Content-Type': contentType,
          'Content-Length': buffer.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(`${cdnBase}/${normalizedPath}`);
          } else {
            reject(new Error(`Bunny upload failed with ${res.statusCode}: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    request.on('error', reject);
    request.end(buffer);
  });
}

async function buildSelfHostedAssets(lessons) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vormex-edu-reels-'));
  const assets = [];

  for (let index = 0; index < lessons.length; index += 1) {
    const [title] = lessons[index];
    const slug = slugify(title);
    const baseName = `${String(index + 1).padStart(3, '0')}-${slug}`;
    const slidePaths = [1, 2, 3].map((slide) => path.join(tempDir, `${baseName}-slide-${slide}.png`));
    const videoPath = path.join(tempDir, `${baseName}.mp4`);
    const thumbnailPath = path.join(tempDir, `${baseName}.jpg`);

    for (let slide = 1; slide <= 3; slide += 1) {
      await renderSlidePng(lessons[index], index, slide, slidePaths[slide - 1]);
    }
    await sharp(slidePaths[0]).jpeg({ quality: 82 }).toFile(thumbnailPath);
    encodeLessonVideo(slidePaths, videoPath);

    const videoBuffer = await fs.promises.readFile(videoPath);
    const thumbnailBuffer = await fs.promises.readFile(thumbnailPath);
    const videoStoragePath = `reels/education/${SELF_HOSTED_MEDIA_VERSION}/videos/${baseName}.mp4`;
    const thumbnailStoragePath = `reels/education/${SELF_HOSTED_MEDIA_VERSION}/thumbnails/${baseName}.jpg`;
    const [videoUrl, thumbnailUrl] = await Promise.all([
      uploadToBunnyStorage(videoBuffer, videoStoragePath, 'video/mp4'),
      uploadToBunnyStorage(thumbnailBuffer, thumbnailStoragePath, 'image/jpeg'),
    ]);

    assets.push({
      videoUrl,
      hlsUrl: null,
      thumbnailUrl,
      previewGifUrl: null,
      sourceTitle: 'Vormex hosted lesson video',
      ctaUrl: null,
      durationSeconds: SELF_HOSTED_DURATION_SECONDS,
      width: REEL_WIDTH,
      height: REEL_HEIGHT,
      fileSize: videoBuffer.length,
    });

    console.log(`Hosted ${index + 1}/${lessons.length}: ${title}`);
  }

  await fs.promises.rm(tempDir, { recursive: true, force: true });
  return assets;
}

async function ensureSeedAuthor() {
  return prisma.user.upsert({
    where: { email: 'educational-reels@vormex.local' },
    update: {
      name: 'Vormex Education',
      username: 'vormex_education',
      headline: 'Daily STEM and career micro-lessons',
      bio: 'Curated educational reels for students learning engineering, product, and career skills.',
      isVerified: true,
      onboardingCompleted: true,
      onboardingCompleteness: 100,
      role: 'system',
    },
    create: {
      id: randomUUID(),
      email: 'educational-reels@vormex.local',
      name: 'Vormex Education',
      username: 'vormex_education',
      headline: 'Daily STEM and career micro-lessons',
      bio: 'Curated educational reels for students learning engineering, product, and career skills.',
      isVerified: true,
      authProvider: 'seed',
      onboardingCompleted: true,
      onboardingCompletedAt: new Date(),
      onboardingCompleteness: 100,
      role: 'system',
      interests: ['education', 'stem', 'career', 'engineering'],
    },
  });
}

async function main() {
  const targetCount = Math.max(1, Math.min(COUNT, MICRO_LESSONS.length));
  const author = DRY_RUN ? { id: 'dry-run-author' } : await ensureSeedAuthor();
  const hostedAssets = SELF_HOSTED
    ? DRY_RUN
      ? MICRO_LESSONS.slice(0, targetCount).map((lesson, index) => ({
          videoUrl: `https://cdn.example.test/reels/education/${SELF_HOSTED_MEDIA_VERSION}/${String(index + 1).padStart(3, '0')}-${slugify(lesson[0])}.mp4`,
          hlsUrl: null,
          thumbnailUrl: `https://cdn.example.test/reels/education/${SELF_HOSTED_MEDIA_VERSION}/${String(index + 1).padStart(3, '0')}-${slugify(lesson[0])}.jpg`,
          previewGifUrl: null,
          sourceTitle: 'Vormex hosted lesson video',
          ctaUrl: null,
          durationSeconds: SELF_HOSTED_DURATION_SECONDS,
          width: REEL_WIDTH,
          height: REEL_HEIGHT,
          fileSize: 0,
        }))
      : await buildSelfHostedAssets(MICRO_LESSONS.slice(0, targetCount))
    : null;
  const commonsFiles = SELF_HOSTED
    ? []
    : TRUSTED_ONLY
      ? Array.from({ length: targetCount }, (_, index) => TRUSTED_COMMONS_FILES[index % TRUSTED_COMMONS_FILES.length])
      : await filterPlayableVideos(await collectCommonsVideos(), targetCount);
  if (!SELF_HOSTED && commonsFiles.length < targetCount) {
    throw new Error(`Only found ${commonsFiles.length} safe playable Commons videos, need ${targetCount}`);
  }

  const now = Date.now();
  const rows = [];

  for (let index = 0; index < targetCount; index += 1) {
    const lesson = MICRO_LESSONS[index];
    const [title, caption, tags] = lesson;
    const hostedAsset = hostedAssets?.[index];
    const fileName = commonsFiles[index];
    const sourceTitle = hostedAsset?.sourceTitle || humanizeFileName(fileName);
    const publishedAt = new Date(now - index * 12 * 60 * 1000);
    const videoIdPrefix = SELF_HOSTED ? 'hosted_edu' : 'commons_edu';
    const videoIdSlug = SELF_HOSTED ? slugify(title) : slugify(fileName);
    const videoId = `${videoIdPrefix}_${String(index + 1).padStart(3, '0')}_${videoIdSlug}`;

    rows.push({
      id: randomUUID(),
      authorId: author.id,
      videoId,
      videoUrl: hostedAsset?.videoUrl || commonsFileUrl(fileName),
      hlsUrl: hostedAsset?.hlsUrl || null,
      thumbnailUrl: hostedAsset?.thumbnailUrl || commonsFileUrl(fileName, '?width=720'),
      previewGifUrl: hostedAsset?.previewGifUrl || null,
      title,
      caption: hostedAsset ? caption : `${caption} Source video: ${sourceTitle}.`,
      durationSeconds: hostedAsset?.durationSeconds || 45 + (index % 55),
      width: hostedAsset?.width || 1080,
      height: hostedAsset?.height || 1920,
      aspectRatio: '9:16',
      fileSize: hostedAsset?.fileSize || null,
      category: 'education',
      skills: tags,
      topics: Array.from(new Set(['education', 'stem', ...tags])).slice(0, 8),
      hashtags: Array.from(new Set(['learn', 'education', 'vormex', ...tags.map((tag) => tag.replace(/[^a-z0-9]/gi, '').toLowerCase())])).slice(0, 10),
      mentions: [],
      language: 'en',
      ctaType: hostedAsset ? 'lesson' : 'source',
      ctaText: hostedAsset ? 'Practice this concept' : 'Source on Wikimedia Commons',
      ctaUrl: hostedAsset?.ctaUrl || (SELF_HOSTED ? null : commonsPageUrl(fileName)),
      visibility: 'public',
      allowComments: true,
      allowDuets: true,
      allowStitch: true,
      allowDownload: false,
      allowSharing: true,
      status: 'ready',
      transcodingProgress: 100,
      viewsCount: 500 + index * 37,
      uniqueViewsCount: 420 + index * 29,
      likesCount: 25 + (index * 7) % 180,
      commentsCount: 2 + (index * 3) % 32,
      sharesCount: 1 + (index * 5) % 44,
      savesCount: 4 + (index * 11) % 90,
      avgWatchTimeMs: 12000 + (index % 20) * 900,
      completionRate: 0.42 + (index % 40) / 100,
      engagementRate: 0.08 + (index % 18) / 100,
      publishedAt,
      scheduledAt: null,
      createdAt: publishedAt,
      updatedAt: new Date(),
    });
  }

  if (DRY_RUN) {
    console.log(JSON.stringify({ dryRun: true, count: rows.length, sample: rows.slice(0, 3) }, null, 2));
    return;
  }

  if (REPLACE) {
    const deleted = await prisma.reels.deleteMany({
      where: {
        OR: [
          { videoId: { startsWith: 'commons_edu_' } },
          { videoId: { startsWith: 'hosted_edu_' } },
        ],
      },
    });
    console.log(`Deleted ${deleted.count} existing educational seed reels before seeding.`);
  }

  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = await prisma.reels.findUnique({
      where: { videoId: row.videoId },
      select: { id: true },
    });

    if (existing) {
      await prisma.reels.update({
        where: { id: existing.id },
        data: {
          ...row,
          id: existing.id,
        },
      });
      updated += 1;
    } else {
      await prisma.reels.create({ data: row });
      created += 1;
    }
  }

  const readyPublicReels = await prisma.reels.count({
    where: { status: 'ready', visibility: 'public', publishedAt: { not: null } },
  });

  console.log(JSON.stringify({
    created,
    updated,
    totalSeeded: rows.length,
    readyPublicReels,
    authorId: author.id,
    authorUsername: 'vormex_education',
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
