# Dead-code audit

Scope: dead-code removal only. No architecture, API, schema, migration or dependency-version changes.
Stack note: the backend is TypeScript (`src/**/*.ts`, compiled by `tsc` to `dist/`), not plain JS.

## Method

- Built an import graph (static `import` / `export from` / `require` / dynamic `import()`) of every file under `src/`, rooted at
  `api.ts`, `index.ts`, `worker.ts`, `scheduler.ts`, `proximity-worker.ts`, `proximity-scheduler.ts`, `src/scripts/*` and `src/tests/*`.
- For every exported symbol outside tests, counted word-boundary references across `src/`, `scripts/`, `load-tests/`, `test-push.js`, `openapi.yaml` (tests included).
- Ran `tsc --noUnusedLocals` for unused imports, locals and non-exported functions.
- Checked each `package.json` dependency against source, scripts, workflows and tooling.
- Checked BullMQ wiring (`src/workers/index.ts`, `src/scheduler/index.ts`) to confirm which scheduler implementation is active.

Result: only 1 orphan file; everything else is reachable. All route/controller/service/middleware modules are reachable from `api.ts`.

## CONFIRMED DEAD — removed

| Location | Symbol | Evidence | Confidence |
|---|---|---|---|
| `src/middleware/activity.middleware.ts` | whole file (`trackActivity`) | Not imported anywhere (src, scripts, tests, docs) | High |
| `src/services/cron.service.ts` | `initCronJobs` | No references; `maintenanceSchedules` is imported directly by `scheduler/index.ts` | High |
| `src/services/cron.service.ts` | `runDailyMatchNotifications`, `runStreakReminders`, `getUsersWithActiveTokens` | Non-exported, never called (not in the `runMaintenanceJob` switch) | High |
| `src/services/scheduled-publish.service.ts` | `startScheduledPublishScheduler`, `stopScheduledPublishScheduler` + `intervalId`, `warnedDbUnavailable`, `CHECK_INTERVAL_MS` | Obsolete `setInterval` duplicate; active path is the BullMQ job calling `publishScheduledReels` in `workers/index.ts` | High |
| `src/services/people-you-know-join.service.ts` | `startPeopleYouKnowJoinScheduler`, `stopPeopleYouKnowJoinScheduler` + `flushIntervalId`, `PENDING_FLUSH_INTERVAL_MS` | Same: active path is `flushPendingPeopleYouKnowNotifications` in `workers/index.ts` | High |
| `src/controllers/people.controller.ts` | `PEOPLE_DEFAULT_LIMIT`, `PEOPLE_SUGGESTION_POOL_MAX`, `PEOPLE_MAX_FILTER_VALUES`, `interestSearchVariants`, `shouldIncludeTotal`, `splitQueryList`, `titleCaseSearchValue`, `getConnectionStatus`, `getMutualConnectionsCount` | Module-private, zero reads (tsc TS6133) | High |
| `src/utils/direct-media-upload.util.ts` | `mimeExtension` | Module-private, zero reads | High |
| `src/infrastructure/proximity/geo-shards.ts` | `shardsForRadius` | Exported, zero references anywhere | High |
| `src/infrastructure/proximity/redis-keys.ts` | `PROXIMITY_FLUSH_TTL_SECONDS` | Exported, zero references | High |
| `src/types/proximity.types.ts` | `PROXIMITY_API_VERSION`, `ProximityErrorBody` | Exported, zero references | High |
| `src/services/public-discovery.service.ts` | `publicWebBaseUrl` | Exported, zero references | High |
| `package.json` | `@types/sharp` | npm-deprecated stub ("sharp provides its own type definitions"); `sharp@0.35` ships its own types | High |
| Unused imports | `AgentAutonomyMode` (agent/orchestrator.service.ts), `enforceTrustTierLimit` (controllers/chat.controller.ts), `optionalAuth` (routes/mentions.routes.ts), `ProximityMode` (services/proximity-presence.service.ts), `pairPartition` + `PROXIMITY_DIRTY_PARTITIONS` (workers/proximity.ts), `pushNotificationService` + `prisma` (services/cron.service.ts), `isPrismaConnectionError` (scheduled-publish.service.ts) | tsc TS6133 / TS6196 | High |

## PROBABLY DEAD — left in place, needs human confirmation

Exported, zero references anywhere (including tests), but they are safety / auth / billing / reliability related, so they may be
"not yet wired in" rather than obsolete. Deleting could hide a missing integration.

| Location | Symbol | Concern |
|---|---|---|
| `src/outbox/service.ts` | `enqueueOutboxEvents` (46 lines) | Outbox batch variant; reliability code, may be intended for future use |
| `src/services/premium-post-boost.service.ts` | `refundUndeliveredPlatformFailure` | Billing/refund logic — possibly an unwired refund path |
| `src/utils/direct-media-upload.util.ts` | `assertObjectKeyOwnedByIntent`, `getStorageObjectMetadata`, `cdnUrlForObjectKey` | Upload ownership check may be a missing security call |
| `src/utils/input-security.util.ts` | `validatePromptSafeText` | Possibly an unwired prompt-injection guard |
| `src/utils/jwt.util.ts` | `generateToken` | Auth; likely superseded by newer token functions |
| `src/services/premium-feature-gates.service.ts` | `sendPremiumRequiredResponse` | Authorization response helper |
| `src/services/activity.service.ts` | `getActivitySummary` (65 lines) | No route/consumer found |
| `src/services/chat-message.service.ts` | `invalidateChatIdentityCache`, `getSafetyErrorResponse` | Cache invalidation could be a missed call |
| `src/config/prisma.ts` | `withWriteTransaction`, `databasePoolConfig` | DB infrastructure |
| `src/infrastructure/realtime/emitter.ts` | `emitRealtimeEnvelope` | Realtime infrastructure |
| `src/utils/email.util.ts` | `isEmailServiceUnavailableError` | Error classifier |
| `src/utils/keyset-pagination.util.ts` | `decodeLegacyIdCursor` | Legacy cursor compatibility; may serve old clients |
| `src/agent/types.ts` | `AgentSurface` (type) | Type only |
| `test-push.js` (repo root) | whole file | Manual FCM test script, not in `package.json`. **Contains a hard-coded device token — consider deleting it.** |

Unused local variables inside active handlers (left alone because removing them may change evaluation or side effects):
`controllers/badges.controller.ts` (`userId` x5, `limit`), `controllers/referrals.controller.ts` (`userId` x2, `limit`),
`controllers/engagement.controller.ts` (`userStats`), `controllers/groups.controller.ts` (`pinnedFirst`),
`controllers/people.controller.ts` (`normalizedSearch`), `agent/pending-actions.service.ts` (`id`),
`services/surface-recommendation.service.ts` (`metadata`).

## DO NOT DELETE

| Location | Why |
|---|---|
| `src/scripts/*.ts` (backfill-*, rotate-encryption-key, seed-full-users, generate-usernames, fix-broken-media-urls, revoke-test-premium) | CLI entry points (package.json scripts / manual ops) |
| `scripts/*.js` incl. `seed-educational-reels.js`, `ensure-dev-schema.js`, `local-neon-credentials.js` | Dev/build/ops tooling |
| `src/index.ts`, `src/worker.ts`, `src/scheduler.ts`, `src/proximity-*.ts` | Process entry points (`start:*` scripts, render.yaml) |
| `src/tests/*` | Run by `npm test` |
| `load-tests/*` | Manual load tooling |
| `swagger-cli`, other `@types/*`, `tsx`, `socket.io-client` | Used by package scripts / TS build / tests |
| `prisma/*`, migrations | Out of scope by instruction |

## Final report

- **Files deleted:** 1 (`src/middleware/activity.middleware.ts`)
- **Functions removed:** 18 (plus 3 exported constants/types, 3 private constants and 4 leftover state vars/consts)
- **Dependencies removed:** 1 (`@types/sharp`); no version changes. `package-lock.json` updated by `npm uninstall --ignore-scripts`.
- **Unused imports removed:** 9 statements/specifiers
- **Validation:**
  - `tsc --noEmit` clean
  - `npm run build` (prisma generate + tsc + openapi copy) OK
  - `npm test`: 376/376 pass
  - compiled worker/scheduler/proximity/controller modules load
  - `node dist/api.js` boots: Firebase initialises, OpenAPI loads (67 endpoints), reaches the Redis-skip log
  - No lint tooling exists in the repo
  - Prisma schema/migrations/DB untouched (`prisma generate` runs as part of the normal build)
- **Not validated:** DB-connected request flows (no live DB exercised).
- **Candidates left for manual review:** 14 rows above (17 exported symbols + `test-push.js`) and 7 files with unused locals.

## Caveats

- The working tree already had ~59 uncommitted modified files before this task (including `prisma/schema.prisma`), so this cleanup's diff is mixed with that work.
- Git reports "dubious ownership" for this directory; commands used a per-command `-c safe.directory`, global git config was not changed.
- Source files use CRLF line endings; edits preserved them.
