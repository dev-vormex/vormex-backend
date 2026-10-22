# Duplication Audit

Analysis only. No source, schema, migration, route or dependency was changed in this phase.

## Summary

**Method.** Six parallel read-only analyses split the backend by area. Each agent grepped for candidate patterns, then read both sides and compared behaviour.

| Slice | Area | Files |
|---|---|---|
| A | Cross-cutting auth, authorization, validation, error format | A |
| B | Content: posts, reels, stories, feed, media, pagination | B |
| C | Social graph, groups, chat, profile, proximity, safety | C |
| D | Notifications, push, email, workers, outbox, Redis, external APIs, config | D |
| E | Premium, billing, games, streaks, admin, moderation | E |
| F | Routes, `src/index.ts`, AI agent, recommendation/discovery | F |

**Domain note.** The prompt's examples (orders, payments, delivery) don't exist in this app. The equivalents audited are: block/privacy/visibility rules, ownership checks, premium entitlement, subscription writes (Razorpay / Google Play / admin), counters and streaks, moderation actions, and trust-tier limits.

**Approximate counts** (summed across slices; the same pattern is sometimes reported in two slices, so treat as ±10%):

| Type | Findings |
|---|---|
| Exact duplication | ~36 |
| Functional duplication | ~39 |
| Business-rule duplication | ~78 |
| Data-access duplication | ~40 |
| Infrastructure duplication | ~42 |
| Intentional (keep separate) | ~38 |

**The headline finding is not copy-paste. It is that the same rule is implemented through several entry points with different strictness.** The same operation is reachable through REST, Socket.IO handlers in `src/index.ts`, the AI agent tools, admin controllers and the report pipeline. Those paths enforce different subsets of block, ban, suspension, trust-tier-limit, visibility and cache-invalidation checks. Many of these differences are authorization or privacy gaps, not style issues. They should be triaged for **security/privacy impact before** being treated as refactor candidates.

**Highest-risk areas**

1. AI agent / socket / REST parity on connections, chat, group join and post engagement (agent `connections_send_request` skips block, ban and trust-tier checks).
2. "Who is visible to whom" has 4+ definitions. Blocks are missing in talk search, contacts, skills, nearby people, follow mutual-info, and reel feeds.
3. Moderation: admin hard-deletes and report-driven ban/suspend skip cache, media and proximity cleanup that user-initiated paths perform. Admin can create extra group owners.
4. Reel domain lacks the checks posts have: mass assignment in `onUploadComplete`, a draft/webhook status clobber, scheduled-reel leakage, no limits or block checks on comments.
5. Account-state checks: Google OAuth ignores `safetySuspendedUntil`; "email not verified" has three codes.
6. Premium entitlement predicate re-derived at about 12 sites with different treatment of admin and CreatorPro. Subscription writes via Razorpay, Google Play and admin lack a shared lifecycle.
7. Streak and date-window logic: UTC vs local-time `setHours`, inert freezes, unscheduled jobs.
8. Notifications: push ignores the self/block suppression that in-app notifications apply (16 of 23 sites). Outbox dispatch has no attempt cap.
9. Counters: share/like/save use different idempotency strategies. Group capacity is checked outside the transaction.
10. Unbounded or NaN `limit` parsing at about 21 sites.

**Caveats.** All findings are from static reading; none were reproduced at runtime. Findings are tagged by confidence in the slice reports below. Some claims were explicitly flagged unverified by their authors (for example the stranger-message limit: only a grep for enforcement was done, so a DB trigger or client-side enforcement would change that finding). Slice IDs (A-B2, B-R1, C-BR-1, ...) are kept so that each finding can be traced.

Slice reports below follow the requested section order. Each slice keeps its own numbering and sub-headings.

## Exact Duplication

### Slice A - Cross-cutting

##### E1. `interface AuthRequest extends Request { user?: {...} }` redefined per controller
- Locations: 29 controllers (e.g. controllers/post.controller.ts:86, reels.controller.ts:37, chat.controller.ts:74, connection.controller.ts:28, admin.controller.ts:33, reports.controller.ts:13, premium-post-boost.controller.ts:10 ...). Canonical type exists: types/auth.types.ts:112 `AuthenticatedRequest` (also used by groups, upload, auth, identity, arcade, events controllers).
- Identical? Near-identical, with type drift. Shape variants: `{ userId: string }` (24 files), `{ userId: string; sessionId?: string }` (admin.controller.ts:33, admin-managed-ads.controller.ts:12, managed-ads.controller.ts:9). The canonical type declares `userId: string | number` plus `authState`.
- Difference that matters: local interfaces say `string`, the real middleware/JWT payload type is `string | number` (utils/jwt.util.ts:96-97, auth.types.ts:114). Every `authorId !== userId` ownership comparison in those 29 controllers silently assumes string; a legacy numeric id would be unequal to every DB string id (fail closed, so Low risk).
- Recommendation: one exported `AuthRequest` alias in types/auth.types.ts plus a `requireUserId(req,res)` helper (see F1). Risk Low. Confidence High.

##### E2. `mediaWriteLimit` rate-limit rule block copy-pasted into 6 route files
- Locations: routes/upload.routes.ts:27, chat.routes.ts:32, post.routes.ts:43, reels.routes.ts:28, stories.routes.ts:17, groups.routes.ts:41.
- Same rules: `rate:ip:media` 60 per 10 min + `rate:user:media` 30 per 10 min (user rule only when authenticated). Verified byte-identical for 5; groups not diffed line by line.
- Key prefixes are identical so counters are shared across routers (probably intended). Consolidate into one exported constant in middleware/abuse-protection.middleware.ts. Risk Low. Confidence High.

##### E3. Chat-media multer + `handleChatUpload` + `validateChatUpload` duplicated
- Locations: routes/chat.routes.ts:50-80 and routes/upload.routes.ts:54-90, both mounting the same `uploadChatMedia` (controllers/upload.controller.ts:538).
- Identical multer limits (fileSize 150 MB, files 1, parts 10, fieldSize 256 KB), identical 413 message. The route in upload.routes.ts is marked "compatibility path" (upload.routes.ts:120). `CHAT_VIDEO_MAX_BYTES = 150*1024*1024` is declared three times (chat.routes.ts:31, upload.routes.ts:26, upload.controller.ts:13) and `CHAT_ATTACHMENT_MAX_BYTES` (25 MB) exists only in the controller, but the 413 message text hard-codes it. Drift risk: change one constant and the route-level cap and the controller cap disagree.
- Recommendation: single `chat-upload.middleware.ts` exporting multer+validator and constants. Risk Low. Confidence High.

##### E4. `EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/` x3 plus inline copy
- controllers/auth.controller.ts:59, password.controller.ts:27, verification.controller.ts:37, and an inline literal at controllers/identity.controller.ts:238. Identical regex. Consolidate into utils/input-security.util.ts. Risk Low. Confidence High.

##### E5. `isUniqueViolation(error)` (Prisma P2002) defined twice
- controllers/follow.controller.ts:19, controllers/reels.controller.ts:41. Identical. `P2002` is also checked inline 10 times across controllers/services. Move to utils/prisma-error.util.ts (already hosts `isPrismaConnectionError`). Risk Low. Confidence High.

##### E6. Profile avatar vs banner upload/delete handlers (EXACT modulo constants)
- controllers/upload.controller.ts:87-163 (`uploadProfilePicture`) vs 164-238 (`uploadBanner`); 239-305 (`deleteProfilePicture`) vs 306-372 (`deleteBanner`). A diff shows only: column (`profileImage` vs `bannerImageUrl`), image processor (`processProfileAvatarWebp` vs `processProfileBannerWebp`), storage method, outbox eventType, message strings, response keys (`avatar`/`avatarUrl` vs `bannerImageUrl`/`bannerUrl`). Same flow: 401 -> validate -> process -> upload -> `$transaction` update + outbox + cache invalidation -> respond.
- Only deviation: avatar handler has an explanatory comment on cache invalidation; behaviour identical.
- Also `uploadCertificate` / `uploadProject` / `uploadLogo` (upload.controller.ts:373-492) are three copies differing only in folder (`certificates|projects|logos/${userId}`), response key and strings. NOTE: all three name files `.avif` while calling `processProfilePicture`; the avatar path uses a WebP processor (comment says "WebP for broad Android support"). Not verified what `processProfilePicture` actually emits; the extension/format may be inconsistent. Confidence Low on that sub-point.
- Recommendation: `createImageUploadHandler({column|folder, processor, ...})` factory. Risk Low. Confidence High.

### Slice B - Content

##### B-E1 Boost "SAFETY pause" UPDATE copy-pasted 3x (+ credit-window upsert 2x)
- A: services/premium-post-boost.service.ts:164-175 (inside `selectPostBoostPlacements`, runs on every home-feed request that reaches boost selection)
- B: same file :258-267 (`recordBoostDelivery`)
- C: same file :280-290 (`maintainPostBoostCampaigns`, with `RETURNING`)
- Also: credit-window `INSERT ... ON CONFLICT` upsert at :31-37 (`getPostBoostCredits`) and :74-80 (`createPostBoostCampaign` tx).
- Duplicated: identical SQL predicate (pending/under_review `moderation_reports` on the post OR author banned/restricted/suspended).
- Type: EXACT. Identical behavior: yes (A/B/C differ only in scope: all active campaigns vs one campaign id; C returns ids).
- Differences: A is a table-wide UPDATE executed inline on a read path (feed render); B is single-campaign; C is the worker. A makes the feed request do a write.
- Consolidation: single `pauseUnsafeCampaigns(campaignId?)` SQL helper; drop A in favor of the worker `maintainPostBoostCampaigns` (needs product confirmation of latency tolerance).
- Risk: Low. Confidence: High.

##### B-E2 `uploadCertificate` / `uploadProject` / `uploadLogo` are one function 3x
- A: controllers/upload.controller.ts:373-411; B: :413-451; C: :453-491
- Duplicated: auth check, file presence, `validateImage(buffer,10)`, `processProfilePicture`, `uploadFile(buf, '<folder>/<uid>', '<ts>.avif')`, error handling.
- Type: EXACT (only folder name, response key `certificateUrl|imageUrl|logoUrl`, and messages differ). Identical behavior: yes.
- Consolidation: `handleSimpleImageUpload({folder, responseKey, label})` factory. Risk: Low. Confidence: High.
- See B-R12 for the behavioral problem they all share (400x400 forced stretch).

##### B-E3 `mediaWriteLimit` rate-limit block defined 6x verbatim
- routes/post.routes.ts:43, reels.routes.ts:28, stories.routes.ts:17, upload.routes.ts:27, chat.routes.ts:32, groups.routes.ts:41
- Identical config (ip 60/10min, user 30/10min, `rate:ip:media`, `rate:user:media`). Note: all six share the same key prefixes, so one user's budget is shared across posts+reels+stories+chat+groups (probably intentional but undocumented).
- `CHAT_VIDEO_MAX_BYTES = 150MB` is also defined 3x (upload.controller.ts:13, chat.routes.ts:31, upload.routes.ts:26). `chatUpload` multer config duplicated in chat.routes.ts:55 and upload.routes.ts:55 (and `uploadChatMedia` is the handler; two routes serve the same job).
- Type: EXACT/INFRASTRUCTURE. Consolidation: export from one `middleware/media-limits.ts`. Risk: Low. Confidence: High.

##### B-E4 Public-post `select` + author select repeated 3x in one file
- services/public-content-discovery.service.ts:98-103 (`searchPublicPosts`), :129-134 (`getPublicPost`), :154-159 (`listPublicProfilePosts`); where-clause `visibility:'public', isActive:true, type:'text', content:{not:''}, author: publicAuthorEligibility()` also repeated at :95, :128, :148.
- Type: EXACT / DATA-ACCESS. Consolidation: constants `PUBLIC_POST_SELECT`, `publicPostWhere()`. Risk: Low. Confidence: High.

##### B-E5 Conversation find-or-create + message insert + socket emit for content-to-DM actions
- A: controllers/stories.controller.ts:785-803 (`reactToStory`), B: :990-1008 (`replyToStory`), C: controllers/reels.controller.ts:1549-1566 (`shareReelInChat`). A and B are near-line-identical for ~80 lines (find conversation OR both orderings, create, load sender, `messages.create`, `conversations.update lastMessageAt`, two `io.to(...).emit('chat:new_message')`).
- Same find-or-create exists at controllers/chat.controller.ts:523-551 and admin-premium.controller.ts:86-96 (5 sites total repo-wide; 3 in this slice).
- Type: EXACT (A vs B), FUNCTIONAL (vs C). Identical behavior: A/B yes except `contentType` (`story_reaction`/`story_reply`), content, and A only runs when author != self.
- Differences vs real chat path: `services/chat-message.service.ts#sendChatMessage` (:444) exists and handles client message ids, push delivery mode, read receipts, identity cache. A/B/C bypass it with raw `prisma.messages.create`, so story replies/reactions and reel-in-chat shares skip whatever sendChatMessage does for push notifications/outbox. C wraps message+share in `$transaction`; A/B do not (message can exist without conversation `lastMessageAt` update).
- Consolidation: route all three through `sendChatMessage` (typed `story_reply`/`story_reaction`/`reel` content types). Risk: Med (client message rendering depends on `fileName` JSON blob for stories and `content` JSON for reels). Confidence: High.

### Slice C - Social & messaging

##### E1. `buildConnectionMetadata` copied verbatim into the AI agent
- A: `controllers/people-contacts.controller.ts:104-176`; B: `agent/tools.ts:838-910` (called at tools.ts:1158, 1325).
- Duplicated: status map + mutual-count map. Same unbounded `connections.findMany` for ALL of the user's rows, same second scan `OR requesterId in targets / addresseeId in targets` with no `take`.
- Type EXACT. Identical behavior: yes, except B adds `.filter(Boolean)` on target ids (tools.ts:839).
- Differences: none material. Note both differ from the capped (500/1000) versions in people/talk (see BR-3), so the unbounded scan is a perf hazard for users with large networks.
- Future: one shared `relationship-summary.service` (statuses + mutual counts, bounded). Risk Low. Confidence High.

##### E2. `uniqueCacheTags` / `uniqueTags` helper (7 copies)
- `connection.controller.ts:41`, `matching.controller.ts:28`, `people.controller.ts:345`, `profile.controller.ts:72`, `chat.controller.ts:134`, `chat-message.service.ts:139`, plus inline in `stories.controller.ts:52`. All `Array.from(new Set(tags.filter(Boolean)))`.
- Type EXACT / INFRASTRUCTURE. Future: export from `infrastructure/cache`. Risk Low. Confidence High.

##### E3. "connection accepted/removed" discovery cache-tag set
- A: `connection.controller.ts:32-61` (`TOP_NETWORKERS_CACHE_TAG`, `discoveryCacheTags`, `invalidateDiscoveryCaches`); B: `services/connection-accepted-side-effects.service.ts:11-23`; constant also at `engagement.controller.ts:31`. Same tag list: `engagement:leaderboard`, `people:user:`, `people:connections:`, `matching:user:`, `user:`.
- Similar-but-different sets elsewhere: `matching.controller.ts:47-52` (adds `matching:global`, no `user:`), `engagement.controller.ts:497-505`, `people.controller.ts:347-351` (`peopleCacheTags`), `discovery-power.service.ts:340`, and `invalidateBlockedUserIdsCache` (`trust-safety.service.ts:793-812`, 12 tags). If a new discovery cache tag is added, each list must be edited by hand.
- Type EXACT (A vs B) / INFRASTRUCTURE. Future: one `cacheTags.forUsers()` module. Risk Low. Confidence High.

##### E4. Chat identity/cache helpers duplicated between controller and service
- A: `controllers/chat.controller.ts:122-250`; B: `services/chat-message.service.ts:127-290`.
- Duplicated: `userSelect`, `uniqueTags`, `chatUserCacheTags`, `notificationCacheTags`, `conversationCacheTags`, `buildFallbackChatUser`, `buildChatUserIdentity`, `getChatPremiumVisibilityByUserIds`, `toIsoString`. `chat.controller` re-implements the DTO mapper (`mapMessagePayload` :261-327 vs `mapChatMessagePayload` service :301-344).
- Type EXACT for the helpers, FUNCTIONAL for the mappers (see BR-6: controller mapper emits a `story` object, service mapper does not).
- Differences in helpers: service `buildChatUserIdentity` defaults `username`/`name` to `''` and is non-generic; controller version is generic, keeps nullish values. `getReadReceiptVisibility` in controller is just an alias to service's cached version (:250), fine.
- Future: service exports the helpers; controller imports. Risk Low-Med (DTO shape). Confidence High.

##### E5. "This resource is unavailable" 404 body
- 16 inline copies of `{ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false }`: chat 2, connection 1 (:706), follow 3 (:194,:239,:305), groups 1 (:1314, cast `as any`), post 1, reels 4, stories 3, profile 1 (helper `sendResourceUnavailable` :93, used 6x). Chat controller builds the same shape via `SafetyActionError('resource_unavailable', 404)` (:100-109).
- Type EXACT / INFRASTRUCTURE. Future: shared `sendResourceUnavailable(res)` + `isBlockedPair(viewer,target)` guard. Risk Low. Confidence High.

##### E6. Small string/number normalizers
- `isProfileUserOnline` (`profile.service.ts:114`) == `isProfileOnline` (`talk.controller.ts:911`): `isOnline || lastActiveAt < 5min`. EXACT (constant inlined in talk).
- `normalizeSearchText`: `people.controller.ts:196` (max 80) == `discovery-power.service.ts:69` (max 100). `parseBoundedInt` (`people.controller.ts:201`) == `clampPageSize` (`utils/keyset-pagination.util.ts:91`) apart from a `min` parameter. 
- `normalizeOptionalString` x4 with 4 different semantics: `groups.controller.ts:173` (non-string => null, trims), `circles.controller.ts:30` (undefined/null/non-string tri-state), `chat-message.service.ts:185` (`String(value)`, does NOT trim), `admin.controller.ts:96`.
- Type EXACT/FUNCTIONAL. Risk Low. Confidence High.

### Slice D - Notifications & infra

##### E-1. `parsePositiveInt(value, fallback)` copy-pasted
- Locations (byte-identical body `Number.parseInt(value || '', 10); finite && > 0 ? parsed : fallback`):
  - infrastructure/redis/client.ts:69
  - infrastructure/proximity/redis-client.ts:8 (named `positiveInt`)
  - infrastructure/health/background-process-heartbeat.ts:30
  - outbox/dispatch-policy.ts:13
  - scheduler/index.ts:7
  - workers/index.ts:42
- Near-identical but different semantics: reengagement-notification.service.ts:158 (uses `Number(raw)` then `Math.floor`, so "1.9" -> 1 and "5abc" -> fallback, while parseInt gives 5); services/matching-engine.service.ts:189; services/premium-access.service.ts:130 and premium-visibility.service.ts:55 (`readPositiveIntEnv`); services/feed/feed-config.ts:518-524 (`envBoolean`/`envNumber`); controllers/*: admin-managed-ads:38, admin-premium:36, events:52 (these are request parsing, not env).
- Identical behavior? Yes for the 6 exact copies; No for reengagement (Number vs parseInt), and hackathon-import.service.ts:62-73 uses a third idiom `Number(env) || default` (accepts 0 -> default, accepts negatives for DEVPOST_MAX_PAGES clamp).
- Differences: parseInt("10ms")=10 vs Number("10ms")=NaN -> fallback. Env value `1.5` -> 1 (parseInt) vs 1 (floor). Subtle only for malformed env.
- Consolidation: single `config/env.ts` (envPositiveInt, envBool, envList). Risk Low. Confidence High.
- Occurrences: 6 exact + 6 variants in services/controllers.

##### E-2. Redis error-log throttle (Map<label, lastLoggedAt> + `now - previous < THROTTLE_MS`)
- infrastructure/redis/client.ts:46-51,115-121 (30s default env REDIS_ERROR_LOG_THROTTLE_MS), infrastructure/proximity/redis-client.ts:5-6,29-35 (hardcoded 30_000 single timestamp), workers/index.ts:48,65,344-356 (WORKER_ERROR_LOG_THROTTLE_MS, keyed by queue:message with a special key for rate-limit messages).
- Same idea, 3 copies. Behavior differs: proximity throttle is global per module (not per label) and not configurable; worker throttle dedups per message text.
- Consolidation: `createLogThrottle(ms)` helper. Risk Low. Confidence High.

### Slice E - Premium & admin

**E1. `readNote` duplicated** (EXACT)
- A: services/premium-checkout.service.ts:105-108; B: services/premium-razorpay.service.ts:113-116. Byte-identical private helpers (read trimmed non-empty string from Razorpay `notes`).
- Recommendation: export once from premium-checkout.service (razorpay.service already imports from it). Risk Low. Confidence High.

**E2. Billing-cycle normalizer duplicated** (EXACT)
- A: premium-checkout.service.ts:114-120 `normalizeBillingCycle`; B: premium-access.service.ts:221-227 `normalizePremiumBillingCycle`. Same mapping (yearly/annual/annually -> 'yearly', else 'monthly'). checkout.service does not import access.service (it is the lower layer), hence the copy.
- Recommendation: move to a tiny `premium-plan.util.ts` both import. Risk Low. Confidence High.

**E3. `startOfUtcDay` / "UTC midnight" helper: 5 copies** (EXACT/FUNCTIONAL)
- progress.service.ts:49-53 (`setUTCHours(0,0,0,0)`), arcade.service.ts:131-133 (`Date.UTC(...)`), managed-ad.service.ts:353-355, engagement.controller.ts:46-50 `getTodayStart`, tier-limits.service.ts:22-24 `getDailyUsageWindowStart`. All compute the same instant. Also inline `today.setUTCHours(0,0,0,0)` x6 in engagement.service.ts (20, 91, 166, 228, 232 ...) and x3 in activity.service.ts (189, 551, 554).
- Recommendation: one `utc-time.util.ts` (startOfUtcDay, isSameUtcDay, isYesterdayUtc, startOfUtcWeek (Mon), startOfUtcMonth). Risk Low. Confidence High.

**E4. `safeCreateMarker` idempotent "marker" XP row** (EXACT apart from `source`)
- A: controllers/learning.controller.ts:66-92 (source 'learning'); B: controllers/jobs.controller.ts:75-100 (source 'jobs'). Both upsert an `xp_transactions` row with amount 0, key `${userId}:${type}:${sourceId}`, catch P2002 and re-read.
- Recommendation: `recordProgressMarker({source,...})` in progress.service (it already owns xp_transactions and `isAlreadyAwarded`/P2002 handling at progress.service.ts:172-215). Risk Low. Confidence High.

**E5. Hackathon text/slug helpers: 3 copies** (EXACT/near-exact)
- `slugify` identical: hackathons.controller.ts:58-64, services/hackathon-import.service.ts:160-166, controllers/college-communities.controller.ts:38-44 (slice neighbour).
- `uniqueGroupSlug` identical loop: hackathons.controller.ts:77-86 and college-communities.controller.ts:50-.. ; `uniqueHackathonSlug` hackathons.controller.ts:66-75 vs hackathon-import.service.ts:168-.. (import version prefixes `${source}-`).
- `cleanText`/`cleanOptionalText`: hackathons.controller.ts:34-41, college-communities.controller.ts:21-27, hackathon-import.service.ts:85-92. Subtle diffs: controllers use `ensureString(value)`, import uses `String(value||'')`; default max 240 vs 280; `cleanList` max item length 48 (controller:43-56) vs hard-coded 60 (import:101-113).
- Recommendation: shared `text-sanitize.util.ts` + `slug.util.ts` (uniqueSlug(model, base)). Risk Low (watch the 48 vs 60 / 240 vs 280 defaults). Confidence High.

**E6. Coin-balance legacy fallback expression: 4 sites** (EXACT)
- `user?.coinsBalance || user?.xpBalance || 0`: games.controller.ts:125-126, store.controller.ts:399, progress.service.ts:485. Note: `||` means a legitimately 0 coinsBalance falls back to the legacy `xpBalance` (see B10).
- Recommendation: `getCoinBalance(userId)` in progress.service. Risk Low. Confidence High.

**E7. accountability partner `select` duplicated twice in one query** (EXACT)
- accountability.controller.ts:28-37 and 38-47 (user1/user2 includes identical select). Recommendation: const `partnerUserSelect`. Risk Low.

### Slice F - API, agent, discovery

**E1. Agent helper copies in orchestrator vs realtime-voice** (5 functions, byte-identical, md5 verified)
- A: agent/orchestrator.service.ts:68 `parseRetryAfterSeconds`, :114 `dedupeUiIntents`, :128 `mergeGoals`, :166 `extractLikelyGoals`, :180 `buildMemorySummary`
- B: agent/realtime-voice.service.ts:94, :120, :134, :152, :166
- Identical: yes. Recommend: `agent/turn-utils.ts`. Risk Low. Confidence High.

**E2. `getAITier` vs `getAITierLabel`**: controllers/ai.controller.ts:6-11 and controllers/ai-chat.controller.ts:447-452. Identical (admin > creator_pro > premium > free). Recommend: one helper beside `getPremiumAccessSnapshot`. Risk Low. High.

**E3. `buildGroupMessagePreview`**: index.ts:627-643 and controllers/groups.controller.ts:373-390. Identical. Shared util. Low / High.

**E4. Media-write rate-limit block copied into 6 route files**: chat.routes.ts:32, groups.routes.ts:41, post.routes.ts:43, reels.routes.ts:28, stories.routes.ts:17, upload.routes.ts:27. Identical (`rate:ip:media` 60/10min, `rate:user:media` 30/10min). Because keyPrefix is identical they all share ONE bucket per user/ip (a chat upload, post upload and avatar upload draw from the same 30/10min). Unknown whether sharing is intended. Recommend: export once from middleware. Risk Low (behavior-preserving) / Med if buckets later split. High on duplication, Med on intent.

**E5. `handleChatUpload` + 150MB multer + 413 message, twice**: routes/chat.routes.ts:55-83 (+`validateChatUpload` :44-50) and routes/upload.routes.ts:55-83 / :90-96. Identical; both mount `uploadChatMedia` (F1). The same multer 413 translation also in routes/identity.routes.ts:51. Recommend: shared single-file upload factory. Low.

**E6. `sigmoid()` and `FEATURE_NAMES`**: recommendation-learning.service.ts:454 / :11 and recommendation-model-serving.service.ts:33 / :10. Identical. Recommend: export from recommendation-engine.service.ts. Low / High. (Latent train/serve skew hazard: feature vector order defined twice.)

**E7. `validateAIRequestInput` applied twice on /api/agent**: index.ts:2901 and routes/agent.routes.ts:38-45 (4 routes). Second scan is a no-op (full body tree walk). /api/ai (:2900) and /api/talk (:2902) have only the app-level copy. Low.

**E8. MCP re-clamps a limit the service already clamps**: mcp/public-discovery.mcp.ts:333 vs services/public-discovery.service.ts:331 (identical `Math.min(10, Math.max(1, Number(x)||5))`). Trivial.

**E9. `titleCaseSearchValue`**: services/discovery-power.service.ts:102-107 and controllers/talk.controller.ts:144-149. Identical. A variant in agent/tools.ts:660-668 differs (see F3).

**E10. Agent tool-result handling x3** is listed in Functional F2 because one copy differs.

## Functional Duplication

### Slice A - Cross-cutting

##### F1. Authentication guard + userId extraction boilerplate (417 sites)
- Pattern: `const userId = req.user?.userId; if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }`. 222 `if (!req.user?.userId)` + 192 `if (!userId)`; 353 identical 401 bodies. Local helpers exist in only three files and are not shared: controllers/recommendation.controller.ts:14 `userIdOrUnauthorized`, arcade.controller.ts:29 `getUserId`, events.controller.ts:91 `getUserId`.
- Divergent behaviours: (a) some responses add `code: 'unauthorized'` + `requestId` (controllers/ai.controller.ts:23-27; auth.middleware.ts:208-228), most do not; (b) different messages: 'Authentication required' (2), 'Authentication required to view own profile' (1), 'Authentication is required to load your activity' (1); (c) controllers/stories.controller.ts:487 `deleteStory` has NO inline 401 guard and relies on the router-level `authenticate` (routes/stories.routes.ts:68): if the router guard were removed, `story.authorId !== undefined` yields a 403 rather than 401 (currently safe); (d) `String(req.user.userId)` coercion used in 224 places, raw in others.
- The inline guard is redundant on the 36 route files that use `router.use(authenticate)`: `authenticate` already returns 401 and guarantees `req.user`. It is only meaningful on optionalAuth routes. No behavioural difference but ~400 lines of dead branches and inconsistent bodies.
- Recommendation: `getAuthUserId(req)` returning string, throwing a typed `UnauthorizedError` caught by one `asyncHandler`/error middleware. Do not remove guards on optionalAuth routes. Risk Low-Med (response-body drift for clients that parse 401s). Confidence High.

##### F2. Admin deletion/ban/suspend flows: three entry points, divergent side effects
See B2/B3 (business rule). Listed here for the functional duplication: `admin.controller.ts` {deletePost 1247, deleteReel 1326, deleteUser 1154, banUser 1061, suspendUser 2405, restrictUser 2368} vs `takeReportAction` 2766 which re-implements warn/restrict/suspend/ban with the same `prisma.user.update` payloads inside a transaction.

##### F3. Verification-OTP issuance duplicated 5x
- auth.controller.ts:250-252 (register), auth.controller.ts:465-467 (login for unverified user), verification.controller.ts:310-312 (resend), identity.controller.ts:300-311 (student email, stored in `identity_verifications.metadata.otpHash`), password.controller.ts (reset uses a token, not OTP: INTENTIONAL separate).
- Same: `generateEmailOtpCode()` + `hashEmailOtp(email, code)` + `new Date(Date.now() + 10*60*1000)` (the TTL literal `10 * 60 * 1000` also appears as `VERIFICATION_TOKEN_EXPIRY` verification.controller.ts:42 and `STUDENT_EMAIL_OTP_TTL_MS` identity.controller.ts:28).
- Differences: see B5 (cooldown/rate limit and enumeration behaviour diverge).
- Recommendation: `issueEmailVerificationOtp(user)` in a service owning TTL, store, and send. Risk Med. Confidence High.

##### F4. Socket handlers re-implement HTTP use cases (cross-ref other slices)
- index.ts:688-760 (post like/react in socket) vs controllers/post.controller.ts:2100-2230 (HTTP toggleLike). Same find-post-check-visibility, create/delete/update-like state machine ("no reaction -> add; same -> remove; different -> switch"), count recompute. Also socket comment/reel handlers at index.ts:810, 926, 989, 1079, 1155. All use `canViewPost/canViewReel` consistently; differences are in outbox/realtime envelope construction. Flag for the posts/reels slice owners; consolidate into services (index.ts is 3113 lines).
- Risk Med. Confidence Med (did not diff the transaction bodies beyond the like state machine).

### Slice B - Content

##### B-F1 Home-feed candidate scoring exists twice: `feed-algorithm.service.ts` (legacy) vs `services/feed/*` (v2), plus a third in `home-recommendation.service`
- A: services/feed-algorithm.service.ts `calculatePostScore` (:~330-395), `normalizeToken` :143, `postSearchText` :266, `contentCompletenessScore` :357, `seenPenalty` :393, `relationshipScore`, `spreadAuthors`.
- B: services/feed/feed-ranker.ts `rankCandidate`, feed-signals.service.ts `postSearchText` :65, `contentCompleteness` :122, `normalizeToken` :52, feed-ranker `seenPenalty` :59, feed-reranker.ts (diversity), feed-viewer-context.service.ts `normalizeToken` :37 (3rd copy).
- C (outside slice): services/home-recommendation.service.ts:137 engagement `likes + 3*comments + 5*shares`.
- Dispatch: controllers/post.controller.ts:1077 (`isFeedV2Enabled` -> v2, falls to legacy on error/decline), :1249 (unified `rankHomePostCandidates`), :1306 (`rankFeedPage` legacy). So 3 live rankers behind flags/experiment variants.
- Type: FUNCTIONAL (same intent, different constants).
- Concrete differences:
  - `normalizeToken`: legacy keeps tokens length>=1 (`length > 0`, feed-algorithm:146); v2 requires length>1 (feed-signals:55, feed-viewer-context:40).
  - Short-token word-boundary rule: legacy `token.length <= 2` (`containsToken`), v2 `token.length <= 3` (`tokenOverlapRatio`). So "ai"/"ml" same, but 3-letter tokens ("sql","aws","git") match substrings only in legacy.
  - `postSearchText`: legacy includes author name/username/headline, link domain, document type, celebration type/badge; v2 omits those.
  - `contentCompleteness`: legacy any non-empty content = +90; v2 needs content >=40 chars (+0.3). Link bonus 80 vs 0.1 (different relative weight).
  - Seen penalty: legacy multiplicative factor 0.12..0.75 by age buckets (1h/6h/24h/72h) and 0.35 when time unknown; v2 additive penalty by configurable minutes/hours buckets + repeat-impression increment (uses `seenCount`), legacy ignores seenCount.
  - Engagement weights: legacy hard-codes like 1 / comment 3 / share 5 / save 4 (feed-algorithm:~340); v2 config like 1 / comment 3 / save 4 / share 5 (feed-config.ts:393-396) - same numbers by coincidence, but legacy is raw-count (no reach normalization) while v2 is Bayesian rate. home-recommendation uses 1/3/5 and omits saves.
  - Relationship: legacy `+2600 following, +2050 connection, +900 own post, +260 connections-visibility post`; v2 additive config weights 0..1 with relationshipStrength; legacy treats "own post" +900, v2 `ownPost`.
- Identical behavior? No. Consolidation: do NOT merge; retire legacy after v2 GA (see B-R3). Shared leaf helpers (`normalizeToken`, `tokenize`, `postSearchText`) could be extracted only after choosing v2 semantics. Risk: Med. Confidence: High.

##### B-F2 Viewer recommendation context built twice
- A: controllers/post.controller.ts:531-666 `buildFeedRecommendationContextForUser` (user profile + 500 connections + 500 follows + profile views, cached 24h, key `buildFeedRecommendationContextCacheKey`).
- B: services/feed/feed-viewer-context.service.ts:78+ `loadFromDatabase` (same entities plus followers, liked/commented/saved creators, message peers, onboarding data; own cache key `feed:v2:viewer-context:*`).
- Both: `prismaRead.user.findUnique` with identical `skills/experiences/projects/educationHistory` select shape and `connections.findMany` accepted OR requester/addressee.
- Differences: caps (experiences 12/12, education 12 vs 8, skills unbounded vs 40, connections 500 vs MAX_CONNECTIONS), `normalizeToken` min length. Cache invalidation is separate (`invalidateFeedViewerContext` only touches B).
- Type: FUNCTIONAL/DATA-ACCESS. Consolidation: after legacy retirement, delete A. Risk: Low-Med. Confidence: High.

##### B-F3 Connected-peer-ids derivation: 4 copies
- A: utils/access-control.util.ts:68 `getConnectedPeerIds` (canonical).
- B: controllers/post.controller.ts:500 `connectionPeerIds` (pure mapper, used by B-F2 A).
- C: controllers/post.controller.ts:1566-1579 inline `peerIds` query in `createPost` for realtime fanout (same `status:'accepted' OR` + flatMap + filter).
- D: services/premium-post-boost.service.ts:195-198 and feed-viewer-context: another `connections.findMany ... take: 500`.
- Type: FUNCTIONAL/DATA-ACCESS. Identical behavior: C vs A yes (except C has no `Set` handling difference). Consolidation: reuse `getConnectedPeerIds(userId, prismaRead)`. Risk: Low. Confidence: High.

##### B-F4 Reel comment "map + select" vs post comment "map + select"
- A: controllers/reels.controller.ts:83-127 (`mapReelCommentAuthor`, `mapReelComment`; `reelCommentAuthorSelect`).
- B: controllers/post.controller.ts:2490-2520 (inline `mapComment` in getComments) and :2602-2625 (inline in createComment, third copy: `mappedComment`).
- Differences: reel author has `verified` alias + `headline`; post comment author is the raw `users` row (select in getComments omits `headline`, createComment select includes `headline`, `identityTrustLevel`). Post comment `mentions` hard-coded `[]` in getComments (:2506) but echoed from the request body in createComment (:2623) and never persisted (post_comments has no mentions column). Reel comment has `isPinned`, `isAuthorHeart`, `repliesCount`; post has `replyCount`, `contentType`, `replies[]`.
- Same JSON key naming drift: `replyCount` (post) vs `repliesCount` (reel). Client must special-case both.
- Type: FUNCTIONAL. Consolidation: shared `CommentDto` mapper per domain with the same field names. Risk: Med (client contract). Confidence: High.

##### B-F5 Author public-profile `select` shape (the "mini author")
- Pattern `id, username, name, profileImage, headline, isVerified, profileBadgeStyle` appears 44x (`profileBadgeStyle: true` across controllers/services/utils); in this slice: post.controller.ts:117-125 `postAuthorSelect` (canonical, +identityTrustLevel), saved.controller.ts:43,47 (2x inline copies), post.controller.ts:2430 & :2467 & :2575 (comment variants), reels.controller.ts:233 `reelInclude.users`, :1485 `shareReelInChat.users`, stories.controller.ts:196,413,531 (3x `headline` but no verified/badge), :704.
- Differences: stories author select omits `isVerified`/`profileBadgeStyle` (story rings never show verification) - may be intentional or drift; saved.controller omits `identityTrustLevel` and `isPremium` flags that mapPostResponse reads (`author.isPremium`, `profileBoostActive` ... always false for saved posts).
- Type: DATA-ACCESS. Consolidation: `selects/user.select.ts` with `PUBLIC_AUTHOR_SELECT`, `AUTHOR_WITH_TRUST_SELECT`. Risk: Low. Confidence: High.

##### B-F6 Post include shape: `postResponseInclude` vs `saved.controller` inline
- A: controllers/post.controller.ts:144-173; B: controllers/saved.controller.ts:39-53 (author, collaborators, likes where userId, saved_posts where userId, pollVotes where userId, `_count.saved_posts`) - same shape as A but hand-copied; any new field added to A (e.g. authorProfileSignals) is silently missing from saved list.
- Type: DATA-ACCESS. Consolidation: export `postResponseInclude` from utils/post.util.ts. Risk: Low. Confidence: High.

##### B-F7 Story views/viewers sync-count helpers
- A: stories.controller.ts:67-80 `syncStoryViewsCount` (count + conditional update), B: :698-705 inline in `getStoryViewers` (same count+update, but counts `rawTotalCount` ignoring blocked viewers). Same denormalized-counter-resync idiom also used in reactToStory (:887-891) and removeStoryReaction (:932-936). See B-R9 for the counter-strategy matrix.
- Type: FUNCTIONAL. Consolidation: `recount(model, where, targetModel, field)`. Risk: Low. Confidence: Med.

##### B-F8 HMAC-signed opaque tokens: 3 independent implementations
- utils/keyset-pagination.util.ts:20-60 (cursor), utils/direct-media-upload.util.ts:62-100 (upload intent), controllers/reels.controller.ts:55-82 (`verifyBunnyStreamSignature`, webhook; different secret and scheme).
- Both utils: base64url JSON payload + `.` + HMAC-SHA256 with `timingSafeEqual`, secret chain `X_SECRET || JWT_SECRET || ENCRYPTION_KEY` with length>=16 guard. Differences: cursor signs with `PAGINATION_CURSOR_SECRET` first; upload token with `DIRECT_UPLOAD_TOKEN_SECRET` first; cursor has `v` version; upload intent checks expiry. Neither is expired-aware for the cursor.
- Type: FUNCTIONAL/INFRASTRUCTURE. Consolidation: `signed-token.util.ts` generic `sign/verify(payload, secretEnv)`. Fallback to JWT_SECRET means 3 token domains share a key (see INTENTIONAL note B-N5 on why domain separation should be kept in payload `v/scope`). Risk: Med (security-sensitive). Confidence: Med.

##### B-F9 Post-media ownership/URL deletion helpers vs generic deleteFile
- controllers/post.controller.ts:960-996 (`collectOwnedPostMediaUrls`, `deleteOwnedPostMedia`) and controllers/upload.controller.ts:493-533 (`deleteFile`) both call `bunnyStorageService.isUserOwnedPath` + `deleteFile` with "warn and continue" error handling; `deleteProfilePicture`/`deleteBanner` (upload.controller.ts:239-371) a third and fourth swallow-and-continue copy. Admin controller:277 a fifth.
- Type: FUNCTIONAL. Consolidation: `StorageCleanup.deleteOwned(urls, userId)`. Risk: Low. Confidence: Med.

### Slice C - Social & messaging

##### F1. REST `sendGroupMessage` vs socket `group:message` (same operation, two copies)
- A: `controllers/groups.controller.ts:2503-2651`; B: `index.ts:2262-2395`.
- Duplicated: membership check, group lookup with recipient ids, reply-target check, `group_messages.create`, payload build, `group:new_message` emit, push fan-out to all other members.
- Type FUNCTIONAL. Identical behavior: NO.
- Differences: (1) socket validates `groupId` length, `content <= 8000`, `fileName <= 255`, and rate-limits via `allowGroupSocketAction` (index.ts:432); REST has no length or rate limits. (2) sender `select`: REST selects 6 fields (id, username, name, profileImage, isVerified, profileBadgeStyle), socket uses `chatUserSelect`. (3) socket echoes `tempId` and falls back `replyTo` to the looked-up reply; REST does not. (4) membership failure: REST 403 JSON, socket emits `error`. (5) Neither filters blocked members from push recipients, neither honors per-member mute (shortcut/`isAddedToMessages` is a separate concept).
- Future: `services/group-message.service.ts` (`sendGroupMessage(userId, groupId, input)`), callers only transport. Risk Med (REST clients currently bypass limits; adding them is a behavior change). Confidence High.

##### F2. Mutual-connections count: `people.controller` vs `talk.controller`
- A: `people.controller.ts:392-490`; B: `talk.controller.ts:209-319`. Line-for-line the same algorithm (accepted ids -> cap 500 -> second scan `requester in targets & addressee in mine OR reverse` -> bucket per target).
- Type FUNCTIONAL. Identical: nearly. Differences: A takes up to 1000 accepted ids (`PEOPLE_MAX_ACCEPTED_CONNECTION_IDS`) then slices to 500; B takes 500 directly (`MAX_MUTUAL_CONNECTION_SCAN_IDS`). A reads `prismaRead` (replica), B reads `prisma` (primary). Different cache keys (`people:accepted-connections:` vs `talk:accepted-connections:`) but same TTL 30s and same invalidation tag `people:connections:<id>`, so double the cache entries for the same data. A reads status via shared `getPeopleRelationshipCapabilities`; B inlines it (see BR-4).
- Future: one `getAcceptedConnectionIds` + `getMutualCounts`. Risk Low. Confidence High.

##### F3. Mutual info in `follow.getMutualInfo` is a third algorithm
- `follow.controller.ts:360-458`: loads ALL accepted connections of both users (no `take`), intersects in JS, `.slice(0, 10)` for display. Count = full intersection size (not capped), unlike people/talk which cap at 500 and return counts only. No block check (BR-1).
- Type FUNCTIONAL. Risk Low. Confidence High.

##### F4. `reactToMessage` REST vs socket `chat:react`
- A: `controllers/chat.controller.ts:1640-1787`; B: `index.ts:2005-2060`.
- Same toggle/replace/add decision tree. REST: three near-identical transaction blocks (added/removed/updated) each enqueuing outbox fan-out + cache invalidation tags, then `invalidateChatCaches` + immediate emit. Socket: direct writes, `io.to(room).emit`, no outbox, no cache invalidation (so conversation/last-message caches can be stale after socket reactions).
- Type FUNCTIONAL (+ inside-file duplication: the REST function repeats the same transaction block 3x; extract `applyReaction(action)`). Risk Med. Confidence High.

##### F5. `findBlockBetween` (pair) vs `getBlockedUserIds` (set) implement the same block-plus-device-scope rule twice
- `trust-safety.service.ts:696-731` vs `:734-791`. Semantically equivalent today (outgoing device scope hash -> linked users; incoming scope on own install hashes -> blocker).
- Differences: pair version is uncached (3 concurrent queries); set version cached 60s. A new device link made within 60s of a block is not reflected in set-based list filters.
- Classified INTENTIONAL-ish (hot path vs bulk) but must be tested together; see Intentional I2.

##### F6. Mark-read REST vs socket
- A: `chat.controller.ts:1246-1380` (participant check inside tx, `updateMany`, outbox + cache tags); B: `index.ts:1873-1910`.
- Differences: REST invalidates `conversationCacheTags` and publishes via outbox, payload `readAt` ISO string; socket does no cache invalidation, emits `readAt` as a `Date`. Both gate sender notification on `shouldNotifySenderAboutReadReceipt`. Both pass `status != READ` update. Neither limits to messages not `hiddenForUserIds`.
- Type FUNCTIONAL. Risk Med. Confidence High.

##### F7. `profile.service` `getCoreProfile` vs `getFullProfile`
- `profile.service.ts:626-795` vs `:937-1274`: same identifier normalization, requested/canonical cache-key dance, `isUUID ? id : username` lookup, `canShowLocation`, `serializeCoarseLocation`, avatar migration, multi-key cache set. Core uses `CORE_PROFILE_USER_SELECT`; Full does `prisma.user.findFirst` with NO `select` (loads token columns into memory; response is whitelisted by hand). Core's `viewerContext` includes connection/follow state (:760), Full's `viewerContext` is only `{ isProfileSaved }` (:1239). Different TTLs (`PROFILE_CORE_CACHE_TTL_SECONDS` vs `PROFILE_BUNDLE_CACHE_TTL_SECONDS`).
- Type FUNCTIONAL. Future: extract `resolveProfileCached(kind, viewer, identifier, build)` and the shared header builder. Risk Med. Confidence Med.

##### F7b. Same-section triple fetch in `getUnifiedContentFeed`
- `profile.service.ts:465-535`: posts and articles blocks repeat the same `OR author/collaborators(accepted)` + `isActive` + `buildPostVisibilityWhere` shape. FUNCTIONAL, extract `profileAuthoredPostsWhere(userId, requesting, typeFilter)`. Risk Low.

### Slice D - Notifications & infra

##### F-1. Notification create + push pairing implemented per-method with inconsistent "created" gating (also BUSINESS-RULE, see B-1)
- notification.service.ts: 23 `pushNotificationService.sendToUser(...).catch(() => undefined)` call sites, each hand-building a push payload that mirrors the in-app `title/body/data` of the notification right above it (e.g. 1132-1155 comment, 1388-1408 reel like, 749-759 hackathon team match, 947-957 endorsement). Title/body/data are written twice per method; push `data` drifts from in-app `data` (push adds `type`, `actorId`, stringifies numbers; in-app keeps native types; titles in push drop the emoji prefix, e.g. in-app '💬 New Comment' vs push 'New Comment' at 1135 vs 1146).
- Same pairing re-done outside the service: controllers/follow.controller.ts:94-110 (notifyFollow + sendToUser with copy-pasted body `${name} started following you`), controllers/connection.controller.ts:197-209 (notifyConnectionRequest + pushConnectionRequest), services/connection-accepted-side-effects.service.ts:79-84 (notifyConnectionAccepted + pushConnectionAccepted), services/people-you-know-join.service.ts (notifyPeopleYouKnowJoined + pushPeopleYouKnowJoined), services/engagement.service.ts (notifyStreak* + pushStreakAtRisk), services/match-availability-notification.service.ts:193-211 (notifyRecommendedMatch + pushRecommendedMatch).
- Copy duplicated between layers: notification.service.ts:590-591 vs push-notification.service.ts:661-662 (`${count} contacts just joined Vormex` / `A contact just joined Vormex`); 575-583 vs push 391-400 ('accepted your connection request'); notifyFollow (1361) has NO push at all inside the service, unlike every other `notifyX` of its kind, so each caller must remember (follow.controller does).
- Type: FUNCTIONAL. Identical behavior? No (see B-1). Consolidation: one `notifyUser({type, title, body, data, actorId, push: true|false|{override}})` that does block/self guard once, persists, and enqueues push via outbox (`enqueueNotificationDelivery` already exists in outbox/helpers.ts:57 and the worker handles `kind` at workers/index.ts:107-171, but it is only used for chat). Risk Med (many callers). Confidence High.

##### F-2. Two retry/backoff vocabularies plus a hand-rolled outbox retry
- BullMQ queue defaults: infrastructure/queue/queues.ts:6-14 (attempts 5, exponential 1s, no jitter, removeOnComplete 100, removeOnFail 500); infrastructure/proximity/queues.ts:14-16 (attempts 3, exponential 1s jitter 0.25, remove 500/1000); workers/proximity.ts:86-87 per-job override (attempts 8, jitter 0.25).
- ioredis retryStrategy duplicated: redis/client.ts:99-108 (250ms * 2^n capped 5000, attempts 3 optional / 5 required) vs proximity/redis-client.ts:22-26 (same formula, cap 2000, attempts env default 3).
- Outbox dispatcher retry: outbox/dispatcher.ts:142-167 sets `status='pending', attempts = attempts+1, availableAt = now+5s` on every enqueue failure with FIXED 5s delay and NO max-attempts check (row `attempts` is incremented but never read for a cutoff; grep "attempts" in outbox/ shows only the SELECT and increment). A permanently failing payload (e.g. unknown queue) is retried every dispatch tick forever and logs an error each time. This is a different retry policy from the BullMQ one downstream and nothing documents it.
- Type: FUNCTIONAL/INFRASTRUCTURE. Consolidation: shared `retryPolicy` constants + cap outbox attempts (quarantine after N). Risk Med (behavior change). Confidence High.

##### F-3. Hackathon audience selection written 3 times with different signal sets
- services/hackathon-import.service.ts:223-298 (`notifyMatchedUsersAboutNewHackathon`): OR of skills(name insensitive) | interests hasSome | onboarding.canTeach hasSome | onboarding.wantToLearn hasSome | same college (insensitive); take = limit*2 (default limit 50), sorts same-college first.
- controllers/hackathons.controller.ts:225-262 (team match): skills | interests | `user_onboarding: { canTeach }` ONLY (no wantToLearn, no college clause; shorthand without `is`), excludes owner, take 30, send 20.
- services/hackathon-digest.service.ts:30-60 (weekly digest): skills | interests | `college in [...]`, no canTeach/wantToLearn, take 500, no ordering.
- Common: `isBanned:false`, same `skills.some.skill.OR[name equals insensitive]` clause literal (3 copies), same-college sort comparator copy-pasted in import:~270 and controller:~255.
- Differences are mostly accidental: a user who "wants to learn X" is notified of new hackathon (import) but not of a team that needs X (controller) and not of the weekly digest. None checks blocks (only createNotification does, and only when actorId is set; digest and import-without-actor have no actor, so no block check applies, which is fine for system messages).
- Consolidation: `buildSkillSignalUserWhere(signals, {college})` in a shared matching util (matching-engine.service.ts:697-727 also builds the same canTeach/wantToLearn/interests OR). Risk Med (changes recipient sets). Confidence High.

### Slice E - Premium & admin

**F1. Daily-activity streak computed twice** (FUNCTIONAL)
- A: services/activity.service.ts:162-257 `calculateStreak`; B: services/progress.service.ts:415-466 `calculateDailyActivityStreak`.
- Same algorithm: load `userDailyActivity`, walk back from today (or yesterday if today inactive) counting `isActive`, then longest-run scan. Identical results for the shared fields {current, longest, lastActive, totalActiveDays}.
- Differences: B also returns `qualifiedToday`, `isAtRisk`; A returns zeros on error and logs per call (activity.service.ts:244, noisy console.log per request); A `updateUserStats` (activity.service.ts:268-420) persists A's result into `userStats.currentStreak/longestStreak` while engagement/progress endpoints surface B -> two sources of truth that agree today only because the algorithm is copy-pasted. Both ignore streak freezes (see B7). B reads the entire `userDailyActivity` history with no `take`.
- Recommendation: delete A's body, call B. Risk Med (stored `userStats.currentStreak` consumers: profile.service.ts:755, reengagement-notification.service.ts:263). Confidence High.

**F2. Week/month window helpers re-derived** (FUNCTIONAL)
- engagement.controller.ts:53-62 `getWeekStart` (Monday, UTC) and engagement.service.ts:226-232 (same math inline) and engagement.controller.ts:894 (month, `Date.UTC(y,m,1)`) vs engagement.service.ts:232 (`setUTCDate(1)`), tier-limits.service.ts:18-20 `getMonthlyUsageWindowStart`. Same result; 3 implementations. Fold into E3 util. Risk Low. Confidence High.

**F3. isPremiumSubscriptionActive vs isCreatorProSubscriptionActive** (FUNCTIONAL)
- premium-access.service.ts:420-450 vs 452-482: identical null/legacy/cancelledAt/currentPeriodEnd/status guard; only the plan predicate differs (`isPremiumEntitlementPlan` vs `isCreatorProPlan`). Note `isPremiumEntitlementPlan` already includes creator-pro, so creator-pro => isPremium = true always (consumer code such as `snapshot.isPremium || snapshot.isCreatorPro` in premium-feature-gates.service.ts:57 and ai.controller.ts:33 has a redundant second operand).
- Recommendation: private `isSubscriptionLive(sub, now)` + two predicates. Risk Low. Confidence High.

**F4. "Are these two users connected" implemented 3+ ways** (FUNCTIONAL)
- skills.controller.ts:570-582 `areConnected` (uses `prisma`, no self shortcut -> false for same id) vs utils/access-control.util.ts:38-60 `areUsersConnected` (uses `prismaRead`, same id -> true, id normalisation). Same `connections.findFirst` accepted-OR shape. Plus inline `connections.findMany` accepted/OR in engagement.controller.ts (8 occurrences of `status: 'accepted'`).
- Differences: replica vs primary read; self -> true/false. skills.endorseSkill guards self earlier (:615) so behaviour equal today.
- Recommendation: use `areUsersConnected`. Risk Low. Confidence High.

**F5. Admin-sent DM re-implements chat send path** (FUNCTIONAL, partly INTENTIONAL)
- A: admin-premium.controller.ts:85-133 (`getOrCreateConversationForUsers`, `buildChatMessagePayload`) and :1038-1172 (message insert, conversation touch, socket emits, push) vs services/chat-message.service.ts `sendChatMessage` (:444-700) and chat.controller.ts:491 `getOrCreateConversation`.
- Differences: admin path skips `assertUsersCanInteract` (block check), `enforceTrustTierLimit('dm')`, clientMessageId de-dupe, `unreadCount` bookkeeping/`lastMessageAt` raw-SQL update (chat-message.service.ts:666), delivery-mode push logic, sender cache; the conversation `findFirst`+`create` is non-atomic (duplicate conversation race, chat.controller handles `createdConversation`). Admin skipping block/trust limits is plausibly intended (support message), the rest is accidental drift.
- Recommendation: add `sendChatMessage({..., bypassSafety:true})` and delete the controller copy. Risk Med. Confidence Med.

**F6. Hackathon "status" derived 3 ways** (FUNCTIONAL; consistent today)
- hackathons.controller.ts:103-108 `computedHackathonStatus` (isActive false -> archived; `endsAt < now` past; `startsAt > now` upcoming; else active), :291-300 Prisma `where` per status, hackathon-import.service.ts:560 (upcoming checked before past) and :757-771 `externalVisibilityWhere`. Boundaries agree (end==now is still active; `gte now`). Order differs only for invalid ranges. Keep, but centralise predicates. Risk Low. Confidence Med.

### Slice F - API, agent, discovery

**F1. Same handler mounted at multiple paths / route aliases**
| Handler | Paths | Notes |
|---|---|---|
| `uploadChatMedia` | `POST /api/chat/upload` (chat.routes.ts:104) and `POST /api/upload/chat` (upload.routes.ts:121) | upload.routes comment: "compatibility path" |
| `uploadGroupIcon`/`uploadGroupCover` | `/api/groups/:groupId/upload/icon|cover` (groups.routes.ts:86-87) and `/api/upload/group-icon|group-cover` (upload.routes.ts:117-118) | second pair adds `validateMultipartFields` + `groupIdFromBody`; first pair has no `validateMultipartFields` |
| `getCurrentLocation` | `/api/location/current` and `/me` (location.routes.ts:16-17) | explicit alias |
| Saved posts | `POST /saved/:postId/toggle`, `POST /saved/:postId`, `DELETE /saved/:postId` (saved.routes.ts:17-19) | 3 endpoints, 1 rule |
| Avatar/banner | `POST /api/upload/avatar|banner` vs `POST /api/users/me/avatar|banner` (profile.controller.ts:683,758) | NOT an alias, behavior differs: see BR10 |
| People search | `GET /api/people` (optionalAuth, `search=`) vs `GET /api/people/search` (authenticate, `q=`) | two cursor formats, two param names, same min-length constant |
Recommend: keep aliases only while mobile clients depend on them; generate from one route factory. Risk Low-Med (client breakage). High.

**F2. executeAgentTool + pending-approval wrapper copied 3 times** (about 55 lines each)
- A: agent/orchestrator.service.ts:564-662 (quota-fallback turn); B: orchestrator.service.ts:983-1090 (Gemini tool loop); C: agent/realtime-voice.service.ts:761-870 (`handleFunctionCall`). Each: build identical 9-field ctx -> detect approval_required/suggested/autonomous_actions_disabled -> `pendingActionsService.createPending` -> rewrite toolResult with pendingActionId/expiresAt/riskLevel -> push executed/suggested/blocked/uiIntents -> `logAction`. A fourth `executeAgentTool` call is the approve path in pending-actions.service.ts:299.
- Identical behavior? No. In A (line 634-636) `blockedAction` is pushed into `suggestedActions`; B and C push it into `blockedActions`. So in quota-fallback mode, blocked results (e.g. "campus filter unavailable", "limit reached") are reported to the client as suggestions. A also does not emit `agent:navigation_preview` (B and C do).
- Recommend: one `runAgentToolWithApproval(ctx, name, args)`; caller-specific sinks. Risk Med (voice + text). High.

**F3. Four independent "people search" implementations** (term parsing + OR builder + scorer)
- Agent: agent/tools.ts:629-752 (used at :1114)
- Talk: controllers/talk.controller.ts:144-195, :360-406 (`buildPeopleWhere`), :427-557 (`scoreCandidate`)
- Discovery power: services/discovery-power.service.ts:102-112, :422-495, :570-700
- Public discovery: services/public-discovery.service.ts:200-304
- (matching-engine.service.ts / people.controller scorers not compared.)
- Same: all search name/username/headline/bio/college/branch/skills/interests. Different: title-case variants (agent `\b\w` uppercase-each-word; talk and discovery-power capitalise first letter + lowercase rest; discovery-power also UPPERCASE); interest match `has` (agent) vs `hasSome` (talk) vs `hasSome` over variants (power); agent also searches user_onboarding.primaryGoal/wantToLearn/canTeach, talk only scores on them; weights unrelated (agent skill 20 / interest 18; talk skill 18 / interest 9; public lexical 0.30 / semantic 0.45).
- Recommend: shared people-query module (term normalizer + where builder); keep scorers separate (different products). Med / High.

**F4. "Nearby" haversine SQL x2 + JS haversine**
- A: controllers/location.controller.ts:93-131 raw SQL; B: services/discovery-power.service.ts:527-568; C: agent/tools.ts:754 `calculateDistanceKm` used at :1167-1190. A and B are the same query (bounding box, `COALESCE(locationPermission,true)`, `shareLocationPublic=true`, `isBanned=false`) differing in prisma vs prismaRead, returned columns, offset. Recommend: A reuses B. Low. For C see BR6.

**F5. Post/reel/comment/poll writers duplicated between index.ts sockets and REST** (6 pairs; divergences in BR9)
- index.ts:686 `togglePostReactionWithFanout` vs post.controller.ts:2080 `toggleLike`
- index.ts:792 `createPostCommentWithFanout` vs post.controller.ts:2538 `createComment`
- index.ts:911 `toggleCommentLikeWithFanout` vs post.controller.ts:2716 `toggleCommentLike`
- index.ts:978 `votePollWithFanout` vs post.controller.ts:2252 `votePoll`
- index.ts:1069 `toggleReelLikeWithFanout` vs reels.controller.ts:1170 `toggleLike`
- index.ts:1138 `createReelCommentWithFanout` vs reels.controller.ts:1948 `createComment`
Non-transactional socket twins: `group:message` (index.ts:2262) vs groups.controller.ts:2503 `sendGroupMessage` (near line-for-line identical); `story:view` (2558) vs stories.controller.ts:574 `viewStory`; `chat:mark_read` (1873) vs chat.controller.ts:1246; `chat:delete_message` (1917) vs :1384; `chat:edit_message` (1965) vs :1538; `chat:react` (2005) vs :1642.
Only `chat:send_message` is properly shared (REST chat.controller.ts:1205 and socket index.ts:1771 both call `sendChatMessage`).
Recommend: services `post-engagement`, `reel-engagement`, `group-message` mirroring `chat-message.service`; REST and socket become adapters. Risk High (realtime + counters). High.

**F6. Four OpenAI client constructions with different config + one raw fetch**
- agent/orchestrator.service.ts:157 (retries 2, timeout `AGENT_AI_TIMEOUT_MS||AI_TIMEOUT_MS||45000`, honors `OPENAI_BASE_URL/AI_BASE_URL`)
- agent/realtime-voice.service.ts:417 (same retries/timeout, IGNORES baseURL)
- services/ai.service.ts:141 (retries 2, timeout `AI_TIMEOUT_MS||20000`, ignores baseURL, logs degraded)
- services/public-discovery.service.ts:80 (timeout 12s, retries 1, lazy singleton)
- services/recommendation-embedding.service.ts:100 raw `fetch('https://api.openai.com/v1/embeddings')`, own 20s AbortController, hard-coded host, checks only `OPENAI_API_KEY` (not `AI_API_KEY`), so a deployment with only `AI_API_KEY` has AI chat but silently no semantic recommendations.
- `OPENAI_API_KEY || AI_API_KEY` appears 4x. Gemini client exists once (orchestrator.service.ts:221-247).
- Recommend: `lib/ai-clients.ts` + one env resolver. Low-Med / High.

**F7. Embedding model/dimension config duplicated**: `DISCOVERY_EMBEDDING_MODEL || 'text-embedding-3-small'` at recommendation-embedding.service.ts:6 and public-discovery.service.ts (EMBEDDING_MODEL ~line 72); one env var drives two vector tables. Dimension is validated (1536) in only one (recommendation-embedding :36, :104); public-discovery relies on the model default. Switching the env to a model with a different default dimension would break public-discovery silently. Low now / Med confidence.

**F8. Recommendation candidate builders (home vs surface)**: services/home-recommendation.service.ts:60-200 vs services/surface-recommendation.service.ts:29-180: two implementations of one pipeline (network ids, semantic score, cascade wave, source tagging, feature vector, `rankRecommendationCandidates`, `createRecommendationSession`). Rule differences in BR7. Recommend shared `buildCandidate()` with per-surface extractors. Med-High / High.

**F9. `group:new_message` sender shape differs by transport**: socket uses `chatUserSelect` (index.ts:615-625: includes isOnline, lastActiveAt, identityTrustLevel), REST selects id/username/name/profileImage/isVerified/profileBadgeStyle (groups.controller.ts:2562-2570). Clients receive different `sender` shapes for the same event. Low / High.

## Business Rule Duplication

### Slice A - Cross-cutting

##### B1. Visibility: `canViewX` (single-row) vs `buildXVisibilityWhere` (list) are parallel implementations with different edge rules
Locations: utils/access-control.util.ts: post `buildPostVisibilityWhere` 94 / `canViewPost` 133; reel 180 / 221; story 265 / 296; group 346 / 364. The module is the single source (consumers: post, reels, stories, groups, reports, saved, social-proof controllers, index.ts:111, feed-signals, profile.service), which is good. Divergences inside the pair:
1. `canViewPost` returns false if `post.isActive === false` (line 142); `buildPostVisibilityWhere` does not add `isActive: true`. List callers must add it themselves (controllers/post.controller.ts:2030 shows `where: { id, isActive: true }` pattern but the builder does not enforce it). Same for stories: `canViewStory` checks `expiresAt` (line ~302) but `buildStoryVisibilityWhere` has no expiry clause; reels do include ready/published in both.
2. Collaborator access: post builder and `canViewPost` grant accepted collaborators; reel/story do not model collaborators at all (fine unless reels gain collaborators).
3. Block application: builders use `getBlockedUserIds` (cached 60s, `trust-safety.service.ts:734`, tag-invalidated), `canViewX` uses `areUsersBlocked` -> `findBlockBetween` (uncached, 3 parallel queries, 696). Both include device-scoped blocks, but the cached list may be up to 60s stale vs. instant for single checks, so a list can show an item that detail then 404s (or reverse right after unblock).
4. Block check ordering differs: `canViewPost` checks blocks before the owner shortcut but skips when viewer === author (line 147); `canViewReel` same; `canViewStory` same. Consistent.
5. Visibility literals: builders list `['public','PUBLIC']`/`['connections','CONNECTIONS']` (lines 17-18, and re-hard-coded in story builder 271/283); `canViewX` lowercases via `normalizeVisibility`. A value like `Public` (mixed case) is visible to `canViewPost` but excluded by the SQL `in` list. Confidence Med that mixed case exists in data; enforced values appear to be lower/upper only.
6. Group: `canViewGroup` allows if `!isPrivate`, else creator or member. `buildGroupVisibilityWhere` is the same set. Consistent.
- Recommendation: keep module, add shared `visibilityLiterals` + have builders include `isActive`/`expiresAt` or document the contract; add a parity test between builder and checker. Risk Med. Confidence High for items 1 and 3.

##### B2. "Delete a post/reel/story/comment" has divergent semantics per actor and content type
- User delete post: soft delete `isActive:false` inside a transaction + cache invalidation outbox + deletes owned media (controllers/post.controller.ts:2048-2075).
- Admin delete post: HARD delete `prisma.post.delete`, no media cleanup, no cache invalidation, no outbox (controllers/admin.controller.ts:1247-1259). Unknown id gives Prisma P2025 -> 500 instead of 404.
- Moderation `CONTENT_REMOVED` on a reported post: soft delete (`isActive:false`) in tx but no cache invalidation, no media cleanup (admin.controller.ts:2793-2799); reported comment: content rewritten to `'[removed by moderation]'` rather than deleted (2801-2805).
- User delete reel: hard delete + `invalidateReelsFeedCache()` + Bunny video delete (reels.controller.ts:1154-1166). Admin delete reel: hard delete only, no Bunny video delete, no cache invalidation (admin.controller.ts:1326-1336) => orphaned stream assets + stale feed.
- User delete story: hard delete + socket `story:deleted` + cache invalidation (stories.controller.ts:496-515). No admin or moderation path for stories/reels in reports (reports.controller.ts only reports post, comment, chat, user, group).
- Comment delete: post comment is author-only (post.controller.ts:2837) and runs in a `$transaction` with outbox realtime + count recompute; reel comment may be deleted by comment author OR reel owner (reels.controller.ts:2236), non-transactional, with separate `repliesCount` decrement on parent. Post-owner cannot remove comments on their own post; reel-owner can. Likely unintended asymmetry; confidence Med (could be product choice).
- Recommendation: domain services `removePost(actor, id, reason)`, `removeReel(...)` owning soft/hard delete, media cleanup, cache invalidation; admin/moderation call the same. Risk High (data lifecycle). Confidence High.

##### B3. Moderation / safety enforcement: user-level restrictions applied in two places with different side effects
- Direct admin actions (admin.controller.ts): `banUser` 1061 sets isBanned, clears suspension/restriction, `recordSafetyEvent`, `invalidateAuthUserStatus`, `revokeAllAuthSessions`, `invalidateUserProximity('admin_ban')`. `suspendUser` 2405: revokes sessions, invalidates auth status, NO proximity invalidation. `restrictUser` 2368: proximity invalidation yes, session revoke no (restriction does not need it). `unbanUser` 1102: does not touch proximity.
- Report-driven (`takeReportAction`, admin.controller.ts:2766-2965): ban/suspend revoke sessions via flag (`revokeSessions`) and `invalidateAuthUserStatus`, but NEVER call `invalidateUserProximity` (grep: proximity invalidation at admin.controller.ts:1093, 1169, 2397 only). A user banned or suspended through a report stays visible in proximity discovery until some other expiry. Confidence High on the code facts; impact depends on proximity TTL (not checked).
- Guards: `banUser` and `suspendUser` reject self (1072, 2418); `restrictUser` and `takeReportAction` self-check only for `report.reportedUserId !== adminId`. None prevent banning another admin.
- Required-reason rules differ: direct `banUser` defaults reason to `'Admin ban'` (1070); `warn/restrict/suspend` require `reason` (400); `takeReportAction` requires `adminNotes` for any action except MARK_UNDER_REVIEW/NONE AND `reason` for safety actions.
- Recommendation: `applySafetyAction(tx, {actor, target, action, reason, until})` in trust-safety.service.ts returning post-commit effects (sessions, proximity, status cache). Risk High. Confidence High.

##### B4. Group role/ownership rules: HTTP user path, admin path, socket path
- Canonical helpers: controllers/groups.controller.ts:337-372 `GROUP_ROLE_RANK`, `normalizeGroupRole`, `getEffectiveGroupRole` (creator => owner), `hasGroupRoleAtLeast`; used 10+ times in groups.controller.ts.
- User `updateMemberRole` (groups.controller.ts:2268-2320): cannot assign `owner`, cannot change creator, requires actor rank >= admin and strictly above both target's current and target role, cannot change self.
- Admin `updateAdminGroupMemberRole` (admin.controller.ts:1648-1692): accepts `owner`; only prevents downgrading the creator. Result: an admin can create additional "owner" members while `creatorId` remains different; `getEffectiveGroupRole` then treats them as role string `owner` rank 4 (since `normalizeGroupRole` accepts 'owner') => the "owner role cannot be changed" invariant (groups.controller.ts:2292) is broken by this path. Also no 404 when membership missing (Prisma P2025 -> 500).
- User `removeMember` (groups.controller.ts:2367-2400): rank-based, `$transaction([delete, memberCount decrement])`, `evictUserFromGroupRoom`, `invalidateGroupListCache`. Admin `removeAdminGroupMember` (admin.controller.ts:1695-1757): creator guard, `$transaction` with COUNT recompute (not decrement), emits `group:member_removed`, does NOT evict the socket room or invalidate the group list cache. Two memberCount strategies (decrement vs recount) coexist.
- Socket delete-message role check (index.ts:2433-2445) re-implements `['owner','admin','moderator'].includes(role)` with inline creator-is-owner logic instead of `hasGroupRoleAtLeast(..., 'moderator')`; semantically equal today but not shared.
- Recommendation: move role helpers to a `group-permissions` util; admin path should pass through the same service. Risk Med-High. Confidence High.

##### B5. Account-status gate at login: four implementations
- Bearer gate: services/auth-gate.service.ts (+ auth.middleware.ts:178-300 message->code mapping by substring `includes('suspended')`/`'disabled'`/`'verification'`).
- Password login: controllers/auth.controller.ts:445-461 (banned 403 `account_disabled`; suspended 403 `account_suspended` + `suspendedUntil`; `!user.isVerified` => resend OTP + 403 `email_verification_required`).
- Refresh: auth.controller.ts:576-606 (banned/suspended + `authProvider === 'email' && !isVerified` => revoke all sessions + clear cookies).
- Google OAuth: controllers/oauth.controller.ts:133 and 182 check `isBanned` only; NO `safetySuspendedUntil` check. A suspended user can complete Google sign-in, receive tokens/session; subsequent authenticated requests then fail the gate with `account_suspended`. Password login rejects at the door. Confidence High.
- Unverified rule differs: login rejects any `!isVerified` regardless of provider; refresh only when `authProvider === 'email'`. Same user class, two predicates.
- Messages for the same condition diverge: login 'Please verify your email before logging in...' (code `email_verification_required`) vs middleware/refresh 'Please verify your email before continuing.' (code `email_not_verified`) vs middleware cached-denial `auth_not_allowed`. Three codes for "email not verified".
- Recommendation: `assertAccountCanAuthenticate(user)` returning the typed reason; reuse the same code table in login/refresh/oauth. Risk Med. Confidence High.

##### B6. Email-verification resend/OTP rules inconsistent
- `auth.login` for an unverified user silently issues + emails a new OTP on every attempt with no cooldown (auth.controller.ts:463-495); `verification.resendVerification` always answers 200 "Verification code sent" for unknown/verified/OAuth accounts (anti-enumeration, verification.controller.ts:285-340) and swallows send errors; `register` returns 409 'User with this email already exists' for verified/OAuth emails (auth.controller.ts:226-231), i.e. it DOES reveal existence; `identity.requestStudentEmailVerification` enforces a 60 s per-address cooldown with 429 (identity.controller.ts:268-290). Login surfaces email-service failure as an error (can reveal "email exists, unverified"), resend does not.
- Rate limiting is applied per route (routes/auth.routes.ts:43-82, routes/verification.routes.ts:15-52) rather than in the controller; identity.routes.ts has 2 limiters. No shared OTP-attempt counter found in the controllers (the verify routes rely on limiter keys by token/email/code). Confidence Med; did not trace limiter keys.
- Recommendation: one OTP service with cooldown policy parameters. Risk Med. Confidence Med.

##### B7. Premium / entitlement predicate ("is premium") re-derived with different inclusion rules
Base: `isPremium` from `isPremiumSubscriptionActive` (services/premium-access.service.ts:420, :577), `isCreatorPro` separate, `user.isAdmin`.
- `hasPremiumEntitlement` = admin OR premium OR creatorPro (services/premium-feature-gates.service.ts:55-57).
- Profile boost: admin OR premium, CreatorPro NOT included (services/premium-visibility.service.ts:329-330, 339).
- Tier limits (project limit, hackathon application): admin OR premium, no creatorPro (services/tier-limits.service.ts:74, 89). `getConnectionRequestLimitState` bypasses the snapshot and recomputes from `user.isAdmin || isPremiumSubscriptionActive(subscriptions)` (tier-limits.service.ts:39).
- AI tier (controllers/ai.controller.ts:7-12, 33; ai-chat.controller.ts:447-452): `getAITier`/`getAITierLabel` are identical functions in two controllers; `isPremium` in the entitlement payload = premium OR creatorPro OR admin (differs from the base `snapshot.isPremium`).
- Discovery: `isPremium: snapshot.isPremium || isAdmin` (services/discovery-power.service.ts:162-165), creatorPro excluded.
- Skills controller: `isPremium` = premium OR admin (controllers/skills.controller.ts:492-493).
- Creator Pro: creatorPro OR admin; premium alone does not grant (services/creator-pro.service.ts:274, 298).
- Net effect: a CreatorPro-only subscriber is premium for AI payload and feature gates but not for profile boost, project limits, discovery power, skills badge, hackathon limits. May be intentional (separate SKUs) but is encoded ad hoc at ~12 sites with no named predicates. Confidence Med that some are accidental.
- Agent access adds a separate rule (premium-access.service.ts:297-315): admin OR (not blocked AND mode != disabled AND premium); `agentLimitReached` is hard-coded false (line ~308), the 'agent_limit_reached' code in middleware/agent-access.middleware.ts:25 can never fire.
- Recommendation: named predicates (`hasPremiumTier`, `hasCreatorProTier`, `isPrivileged`) on the snapshot, tested. Risk Med. Confidence High on the facts, Med on intent.

##### B8. Connection request creation: HTTP vs AI agent tool vs trust tiers
- HTTP `sendConnectionRequest` (controllers/connection.controller.ts:73-232): parallel receiver/requester/existing loads + `assertUsersCanInteract` (ban/suspend/restrict/block, incl. device-scoped blocks) -> 404 -> existing accepted/pending short-circuit -> `getConnectionRequestLimitState` (free daily cap, 403 `connection_request_limit_reached`) -> `enforceTrustTierLimit('connection_request')` (24h rolling cap by trust level, trust-safety.service.ts:~60) -> update rejected row or create -> in-app + push notification -> discovery cache invalidation.
- AI agent tool `connections_send_request` (agent/tools.ts:1470-1560): checks only invalid user/self, any existing row (including rejected, which HTTP re-sends), and the free daily cap. It skips `assertUsersCanInteract` (blocks, banned/suspended target, sender restriction), skips `enforceTrustTierLimit`, does not verify the target exists (FK error) and sends no notification/push and no cache invalidation. Net: the agent can send requests to users who blocked the sender or to banned users, and bypass trust-tier limits. Confidence High (read both). Risk High.
- Two independent limiters coexist: tier-limits (calendar/daily window `getDailyUsageWindowStart`, counts `connections.createdAt`, premium unlimited) and trust-tier (`ACTION_WINDOW_SECONDS` rolling 24h via counter). Note a re-sent request that updates an existing rejected row does not change `createdAt`, so the daily cap does not count re-sends (Low impact).
- Recommendation: `ConnectionService.sendRequest(actor, target)` used by controller, agent, matching UI; Risk High. Confidence High.

##### B9. Restricted-user enforcement is applied per action inconsistently
- `assertUsersCanInteract` (trust-safety.service.ts:819-856) is the only place `safetyRestrictedUntil` is enforced for actors. It is called for: comment reply (post.controller.ts:2573), comment reaction (2747), reel/story reactions/DMs, connection requests, follow, chat (14 sites), socket events (index.ts:1696-2125). It is NOT called on post like/reaction (post.controller.ts ~2100-2230; only `canViewPost`) nor top-level post comment creation path at 2557 (`enforceTrustTierLimit('comment')` + visibility only; assert only for replies). A restricted (not suspended) user can still like posts and top-level-comment on posts but not reply or react to comments. Whether "restricted" is meant to block likes is a product question; the divergence between sibling actions is the finding. Confidence Med.

##### B10. Report creation rules differ by target type
controllers/reports.controller.ts: `reportUser` rejects self-report (line 449); `reportPost` 145, `reportComment` 211, `reportGroup` 513 allow reporting your own content (no `authorId === reporter` check); `reportGroup` has no `blockUser` option; only `reportChat` dedupes open reports (276-330: reuses open report, can upgrade to block); other types create duplicate open reports each submit. Each uses `canViewX` for access (404 when not visible, good and consistent). `createReportWithSafety` (61) is shared and correct. Recommendation: put self-report and dedupe rules into `createReportWithSafety`. Risk Low-Med. Confidence High.

### Slice B - Content

##### B-R1 Reel feed ignores block list and visibility rules that every other surface applies
- A (canonical rule): utils/access-control.util.ts:180-219 `buildReelVisibilityWhere` (public + owner + accepted-connection `connections` visibility, `status:'ready'`, `publishedAt != null`, `authorId notIn blocked`).
- B: controllers/reels.controller.ts:353 `getReelsFeed` and :466 `getTrendingReels`: hard-coded `{status:'ready', visibility:'public', publishedAt:{not:null}}` with NO `getBlockedUserIds` filter and no connection-visibility reels. A user who blocked X still gets X's public reels in For-You / Following / Trending feeds. Anonymous cached feed (`anonymousReelsFeedCacheKey`) is fine because anonymous.
- C: :2455 `getReelsByHashtag`, :2494 `getReelsByAudio` apply `authorId notIn blocked` but still `visibility:'public'` literal and DO NOT require `publishedAt != null`; :2541 `getUserReels` filters `status:'ready'` + `visibility:'public'` for non-owner but no `publishedAt` check and no connection visibility (connections-only reels never show on a connected user's reels tab, though `canViewReel` would allow them).
- Concrete consequences: (1) block not honored in For-You/Following/Trending feeds; (2) reels with `scheduledAt` in the future but `status:'ready', publishedAt:null` (see B-R7) leak through hashtag/audio/user lists; (3) `visibility` compared case-sensitively (`'public'`) while access-control accepts `'public'|'PUBLIC'` (B-R4).
- Type: BUSINESS-RULE (divergent implementations of "who may see this reel"). Identical behavior? No.
- Consolidation: all reel list queries compose `buildReelVisibilityWhere(viewerId)` + their own filter (hashtag/audio/user). Risk: High (privacy/block bypass). Confidence: High.

##### B-R2 Block/interaction policy applied to post comments but not reel comments; trust-tier limits applied to posts only
- Post: controllers/post.controller.ts:2562 `enforceTrustTierLimit(userId,'comment')`, :2573 `assertUsersCanInteract(...,'comment reply')`, :2747 comment-like `assertUsersCanInteract`, :2398-2412 `getComments` filters blocked authors (top-level + replies).
- Reel: controllers/reels.controller.ts:1948-2140 `createComment` has none of these (no trust-tier limit, no block/interaction check on parent comment author, no mention policy); :2142 `toggleCommentLike` no `assertUsersCanInteract`; :1853 `getComments` no blocked-author filter and does not exclude `isHidden` comments (column exists, `grep isHidden` finds no usage in reels controller).
- `enforceTrustTierLimit` call sites in content slice: post.controller.ts:1496 ('post'), :1498 ('media'), :2562 ('comment'); reels.controller.ts:1546 ('dm' only), stories.controller.ts:782,987 ('dm' only). So creating a reel, creating a story, and commenting on a reel are not trust-tier rate-limited; creating a post and commenting on a post are.
- Type: BUSINESS-RULE. Risk: High (spam/abuse vector on reels). Confidence: High.
- Consolidation: shared `assertCanCommentOn(entity, actor, parentComment?)` policy used by post+reel; trust-tier actions 'reel' and 'story' added.

##### B-R3 Post feed: hidden authors, not-interested, reported posts only honored by v2/unified rankers
- v2: services/feed/feed-eligibility.service.ts:62-100 loads `recommendation_feedback` (HIDE_AUTHOR, NOT_INTERESTED), user's own `moderation_reports`, and globally negatively-rated posts; `filterEligibleCandidates` drops them (+ `tooOld`).
- unified: services/home-recommendation.service.ts:104-105 does the same for NOT_INTERESTED/HIDE_AUTHOR.
- legacy path (controllers/post.controller.ts:1160-1307 `computeFeedPayload` with `rankFeedPage`) and `mode==='latest'` apply only block + visibility: a user who clicked "hide author"/"not interested" sees those posts again whenever the request falls to legacy (v2 flag off, v2 error, v2 decline, `latest` mode, personalization off). The comment in feed-eligibility.service.ts:19-21 ("the legacy ranker ... applies the same gate") is only true for blocks.
- Banned authors: v2 excludes (`u."isBanned" = false` candidate-generators.ts:189, and `author?.isBanned` feed-pipeline.service.ts:131). `buildPostVisibilityWhere`/`canViewPost`/legacy feed/`getPost` have no `isBanned` check; no code in slice deactivates a banned user's posts (`post.updateMany` not found). Public discovery excludes banned + restricted + suspended authors (public-content-discovery.service.ts:50-60); premium boost pauses them (B-E1).
- Type: BUSINESS-RULE (eligibility). Risk: High. Confidence: Med (ban cascade may happen elsewhere, e.g. admin controller, not in slice; hide/not-interested gap is confirmed).
- Consolidation: single `FeedEligibility` applied by all rankers (move `loadEligibilityContext` result into `buildPostVisibilityWhere` options).

##### B-R4 "visibility" value casing and normalization is inconsistent across posts, reels, stories
- Posts: write path normalizes via utils/post.util.ts:247 `parseVisibility` -> lowercase `public|connections|private`; read mapper `mapVisibilityToFrontend` -> UPPERCASE.
- Stories: stores UPPERCASE via `normalizeStoryVisibility` (stories.controller.ts:143-148); reads via `buildStoryVisibilityWhere` (`['PUBLIC','public']`) so tolerant.
- Reels: stores raw `req.body.visibility || 'public'` with NO validation at create (reels.controller.ts:847), `onUploadComplete` (:971), and `updateReel` (:1036 copies `req.body.visibility` as-is). A client sending `PUBLIC`, `Public`, `friends`, or `""` stores it. `canViewReel` normalizes (lowercase compare) so `PUBLIC` is viewable by `canViewReel` but invisible in every list query that uses `visibility:'public'` (:353, :466, :2455, :2494, :2541) and in `reel.visibility === 'public'` cache-invalidation checks (:872, :987). Unknown value (e.g. `friends`) is hidden for everyone but the owner.
- Post "private" (`parseVisibility` accepts PRIVATE -> `private`): `canViewPost` returns false for non-owner/collab; but the home feed `buildPostVisibilityWhere` does not include `private` for owner? It includes `authorId: viewerId` regardless, ok.
- `normalizeVisibility` helper is private in access-control.util.ts:30 and not exported; 4 other normalizers exist: post.util.ts:240,247; stories.controller.ts:143; feed-algorithm.service.ts:350 inline `.toLowerCase()`; post.controller.ts:307/2642 inline `String(visibility||'public').toLowerCase()`; services/home-recommendation.service.ts:173.
- Type: BUSINESS-RULE. Risk: Med-High (reel visibility bypass/hide; also `publishDraft` forces `visibility:'public'`, see B-R7). Confidence: High.
- Consolidation: one `Visibility` enum + `parseVisibility` shared by posts/reels/stories, stored canonical lowercase (or uppercase), validated at all writers.

##### B-R5 Share semantics: post share is non-idempotent counter bump; reel share is once-per-user
- Post: controllers/post.controller.ts:2887-2960 `sharePost` increments `sharesCount` on every call, writes no share row, no notification to author, no `allowSharing` check (post has none), emits `post:shared`. Any client (or a loop) can inflate shares unlimited.
- Reel: reels.controller.ts:1346-1457 `shareReel` creates `reel_shares` row (unique `[reelId,userId]`, schema.prisma:2134) in a transaction and increments only on first share; duplicate share -> unique violation -> count unchanged; checks `allowSharing`; notifies author (`notifyReelShare`). `shareReelInChat` (:1459-1700) uses `createMany skipDuplicates` (so first "copy_link" share then a chat send counts once; and one share row per (reel,user) regardless of recipient).
- Share URL: sharePost returns `${FRONTEND_URL || 'https://vormex.com'}/post/<id>` (:2945). Everywhere else the fallback host is `vormex.in` (groups.controller.ts:25, referrals.controller.ts:130, recommendation-embedding:7) or `www.vormex.in` (public-discovery:11,69). `shareReel` returns no URL.
- Post share also feeds the ranker with weight 5, so inflation directly boosts ranking (legacy `calculatePostScore` uses `sharesCount*5`).
- Type: BUSINESS-RULE. Risk: Med-High. Confidence: High.
- Consolidation: `post_shares` table + once-per-user counter like reels (or accept repeat shares but rate-limit); a single `buildShareUrl(kind,id)` util.

##### B-R6 Like/reaction/save toggle: same intent, 3 different concurrency/idempotency strategies
- Post like (post.controller.ts:2080-2250): `$transaction`; reads existing, create/delete/update-reaction (5 reaction types), then `likesCount = COUNT(*)` and write absolute count; realtime + cache invalidation through outbox; unique violations on concurrent double-tap bubble as 500 (no P2002 handling).
- Reel like (reels.controller.ts:1170-1287): read existing outside tx; delete path `deleteMany` guarded with `count===1` then atomic `decrement:1` (idempotent); create path atomic `increment:1` with P2002 caught (idempotent); no reaction types (like only); socket emit direct via `getIO()`.
- Reel save (:1289-1344): create/delete then recount `COUNT(*)` and write `savesCount` - non-transactional (create succeeds, count update can fail; concurrent toggles can be lost; unique violation 500). Post save (saved.controller.ts:148-205): no denormalized counter at all (count query each time; `_count.saved_posts` in includes); has an extra `savePost`/`unsavePost` explicit endpoints (:207-268) - `savePost` skips `recordAuthoritativeRecommendationOutcome` that `toggleSave` calls, so saving via the explicit endpoint produces no ranking signal.
- Comment-like: post (post.controller.ts:2716) transactional recount; reel (reels.controller.ts:2142) non-transactional recount.
- Counter strategy matrix: post.likes recount-in-tx; post.comments recount (top-level only) in tx; post.shares blind increment; reel.likes atomic inc/dec; reel.saves recount no-tx; reel.comments atomic increment on top-level create but delete path recounts; reel.shares inc once; reel parent `repliesCount` inc/dec atomic; story.views recount on every view (O(views) per view call); story.reactions recount.
- Notification-on-like: post notifies only on brand-new reaction (not switch), via outbox push AND direct `notifyPostLike` (two push paths, post.controller.ts:2162 and :2189; potential double notification); reel notifies via direct `notificationService.notifyReelLike` on every like (re-like after unlike re-notifies). Story reaction: no notification, but sends a DM every time the same user reacts again (stories.controller.ts:765-870 runs the DM block regardless of `existingReaction`).
- Type: BUSINESS-RULE (counter + notification semantics). Risk: Med. Confidence: High.
- Consolidation: shared `toggleEngagement({entity,userId})` with unique-violation tolerant atomic counters; single notify policy (first-time only).

##### B-R7 Reel publish/schedule/draft rules are spread over 6 places and contradict each other
- createReel (reels.controller.ts:754-890): `status = draft ? 'draft' : usedBunnyStream ? 'processing' : 'ready'`; `publishedAt = (!draft && !usedBunnyStream) ? now : null`. A future `scheduledAt` on the non-Bunny path is stored but reel is published immediately (publishedAt=now), so scheduling is silently ignored.
- onUploadComplete (:891-996): `status = isDraft?'draft':'processing'`; `...metadata` spread AFTER explicit fields into `prisma.reels.create` data: any key in the request body (e.g. `status:'ready'`, `authorId`, `viewsCount`, `publishedAt`, `isResponse`) overrides computed values -> mass assignment (authorId override possible because spread comes after `authorId: userId`). It also never sets `mentions/skills/topics/allow*` parsing (they arrive only via the spread, unparsed).
- transcodingWebhook (:2991-3069): sets `status:'ready'` unconditionally (also for drafts), sets `publishedAt` only when `!isDraft && !hasScheduledFuture` where `isDraft = reelRecord.status==='draft'`. After the webhook a draft has `status:'ready', publishedAt:null`, so `getDrafts` (`status:'draft'`, :2689) no longer lists it and `publishDraft` (:1068, requires `status==='draft'`) rejects it ("Only drafts can be published"). Draft reels uploaded through Bunny Stream become unreachable/unpublishable after transcoding (confidence Med; trace is from code reading, not runtime).
- publishDraft (:1068-1128): forces `visibility:'public'` overriding the author's chosen visibility; scheduled branch sets `status:'ready'` + `publishedAt:null`.
- scheduled-publish.service.ts:9-22: publishes `status:'ready', scheduledAt<=now, publishedAt:null`. But a ready+unpublished reel is already visible through hashtag/audio/user lists (B-R1), so "scheduled" content is visible before its time.
- updateReel (:998-1066) lets owner set `scheduledAt`/`visibility` raw with no status interplay (re-schedule a live reel to future does not unpublish).
- Type: BUSINESS-RULE (status transitions). Risk: High. Confidence: Med-High (mass assignment and draft/webhook clash High; schedule effects Med).
- Consolidation: reel state machine `transition(reel, event)` used by create/webhook/publishDraft/scheduler; explicit allowlist for `onUploadComplete` body.

##### B-R8 Comment delete authorization and counter handling
- Post: controllers/post.controller.ts:2807-2885 author-only (403 "only delete your own"); post owner CANNOT delete other users' comments on their post. Transactional recount of top-level comments; realtime + cache invalidation via outbox.
- Reel: reels.controller.ts:2201-2263 comment author OR reel owner may delete; non-transactional: delete, decrement parent `repliesCount`, recount top-level, write `commentsCount` (3 writes, no tx). No realtime event emitted on delete (post emits `comment:deleted`).
- Story replies are DMs (no deletion). 
- Post comment-create replies don't notify the parent comment author (only post author at post.controller.ts:2670); reel replies notify the parent author (`notifyReelCommentReply`) and @mentions (below).
- Type: BUSINESS-RULE. Risk: Med. Confidence: High.

##### B-R9 @mention semantics differ completely between post, post-comment, reel-comment, and the "mentions" controller
- Post: client sends user IDs (`mentions` field -> `metadata.mentions`, post.util.ts StoredPostMetadata); notified after create only if `canViewPost(postForAccess, recipient)` is true (post.controller.ts:1687-1747) - good: no side channel around visibility. Collab invites still sent to non-readers (preview withheld) with no `assertUsersCanInteract` (blocked users can be invited).
- Post comment: `mentions` echoed from request, not validated, not persisted, no notification (post.controller.ts:2546, :2623).
- Reel comment: usernames extracted server-side from content via regex `normalizeMentionUsernames` (reels.controller.ts:129-144, `@[A-Za-z0-9_][A-Za-z0-9_.-]{1,29}`) merged with body mentions, stored in `reel_comments.mentions[]`; notifies every matched user `isBanned:false` (:2075-2106) with NO `canViewReel` check and NO block check -> a mention in a comment on a connections-only reel pushes the comment text to people who cannot open the reel, and blocked users can be mentioned. Reel caption `mentions` (createReel :828) stored unparsed `safeJsonParse`.
- mentions.controller.ts: `createMentions` (:116-173) is a stub returning `mentions: []` after validating (message: "pending full implementation"); `getPendingMentions`, `getMyMentions`, `respondToMention`, `toggleShowOnProfile`, `getProfileMentions`, `getMentionCount` are stubs/empty. `searchMentions` filters blocked + banned users; its mini-user select duplicates B-F5.
- No shared mention extractor; no hashtag extractor exists at all for posts (reels store client-sent `hashtags[]` verbatim; hashtag feed matches `has: hashtag` case-sensitively with no `#` stripping/lowercasing: reels.controller.ts:2452).
- Type: BUSINESS-RULE. Risk: Med (notification privacy leak on reel comments). Confidence: High.
- Consolidation: `extractMentions(text)` + `notifyMentions(entityPolicy)` shared; hashtag normalization util (lowercase, strip `#`, dedupe).

##### B-R10 Poll voting: post vs reel
- Post (post.controller.ts:2252-2370): validates optionId exists in stored options, poll ended check, already-voted check, transaction creating vote + rewriting `metadata.pollOptions` + outbox; response key `userVotedOptionId`.
- Reel (reels.controller.ts:2312-2384): no validation that `optionId` is a real option (vote row created for any value; counters unchanged), no tx between `reel_poll_votes.create` and `reels.update` (vote persisted with stale/unchanged options on failure), response key `userVotedOption` (post uses `userVotedOptionId`), `votes+1` read-modify-write on a JSON column (lost update under concurrency; same for post metadata JSON read-modify-write, which additionally overwrites the whole `metadata` blob and can clobber a concurrent collaborator update).
- Both: existence check then create (TOCTOU) -> unique violation surfaces as 500, not "already voted".
- Quiz (`answerQuiz` :2386) compares `optionId === reel.quizCorrectIndex` (type must match: string vs number).
- Type: BUSINESS-RULE. Risk: Med. Confidence: High. Consolidation: shared poll service (validate option, atomic update via vote table counts).

##### B-R11 Reel/story reports bypass the moderation pipeline used for posts/comments
- Posts/comments: controllers/reports.controller.ts:145-275 -> `createReportWithSafety` -> `moderation_reports` (evidence snapshot, optional block-after-report, reason normalized, safety signals). Feed eligibility (feed-eligibility.service.ts:75-80), boost safety (E1), and `recommendation_item_daily_stats` consume this table.
- Reels: reels.controller.ts:2926-2989 `reportReel` writes `reel_reports` with a 6-value reason allowlist (`spam, harassment, violence, nudity, misinformation, other`) vs report reasons list in reports.controller.ts:15-26 (`hate_speech, inappropriate, impersonation, ...`); no evidence snapshot, no block-after-report, no safety hooks; only consumer is services/recommendation-learning.service.ts:285. Reel comments and stories have no report endpoint in this slice.
- Type: BUSINESS-RULE. Risk: Med. Confidence: High. Consolidation: `reportReel` -> `createReportWithSafety({reportType:'REEL',...})`.

##### B-R12 One image pipeline reused for assets with different geometry; delete paths skip cache invalidation
- upload.controller.ts:395,435,475 certificates/project images/logos go through `processProfilePicture` (image-processing.service.ts:21-33): forced `400x400 fit:'fill' avif` -> non-square certificates/project screenshots are stretched/distorted and downscaled to 400px.
- `uploadProfilePicture`/`uploadBanner` call `invalidateProfileMediaCaches` (:148, :223) but `deleteProfilePicture` (:239) and `deleteBanner` (:306) do not -> stale cached profiles keep the deleted avatar/banner until TTL.
- `validateImage(buffer,10)` repeated in 5 handlers after multer already enforces 10MB (upload.controller.ts:66-72) and route-level `imageUploadRule(10MB)`: 3 layers of the same 10MB rule; `POST_IMAGE_MAX_BYTES`, `REEL_THUMBNAIL_MAX_BYTES` (10MB) in direct-media-upload.util.ts:30-33 are a 4th/5th definition, plus routes use `POST_MULTIPART_FALLBACK_MAX_BYTES` (10MB, env) / `REEL_MULTIPART_FALLBACK_MAX_BYTES` (15MB env) while `REEL_VIDEO_MAX_BYTES` = 150MB for the direct path: a reel video through the multipart `createReel` route is capped at 15MB but via Bunny TUS at 150MB.
- Type: BUSINESS-RULE/INFRASTRUCTURE. Risk: Low-Med. Confidence: High.

##### B-R13 Story rules that differ from posts/reels
- Views: viewStory (stories.controller.ts:574-650) unique-per-viewer rows, owner views excluded, `viewsCount` resynced from rows every call; reels `trackView` (reels.controller.ts:1797-1850 + `flushViewBatch` :1709-1795) counts owner views (no owner exclusion), counts anonymous views as separate rows each flush, `viewsCount = total rows` while `uniqueViewsCount` = distinct non-null userIds, ignores watch<3000ms (undefined watchTimeMs passes the `< 3000` guard as NaN comparison false), batches in a process-local in-memory Map (lost on restart, not shared across instances, duplicate flushes per instance). Posts record "impressions" only via feed-impression.service.ts (client viewport) and never a per-post view counter.
- Story media: `createStory` (:267-396) has no trust-tier limit/media check, takes `mediaType` from the JSON body unvalidated (`VIDEO` with no `mediaUrl` possible), no upload validation beyond route-level; `thumbnailUrl = mediaUrl` for videos. Story/reel/post media types, size limits, and storage prefixes are three separate implementations (`uploadStoryImage/Video`, `uploadPostImage/Video`, `uploadReelThumbnail` in bunny-storage.service.ts).
- Story lifecycle: `deleteStory` hard-deletes the row but does not delete storage media (post delete does, `deleteOwnedPostMedia`); expired stories are never cleaned (`story.service.ts:9` `cleanupExpiredStories` is a TODO stub; no `stories.deleteMany` anywhere); `archiveStory`, `createHighlight`, `getUserHighlights`, `getArchivedStories`, `getStoryReplies` (:1113-1220) are stubs that return success (`highlight.id:'temp'`) while doing nothing.
- Story visibility has a `PRIVATE` value in `normalizeStoryVisibility` that is only enforced as "author only" implicitly by absence in `buildStoryVisibilityWhere`; consistent with `canViewStory`, OK.
- Not-found response shapes: stories use `404 {error:'This resource is unavailable.', code:'resource_unavailable', retryable:false}` for hidden/blocked (anti-enumeration) via `sendStoryUnavailable` (:55) and again inline at :431,:526; reels use the same shape only in `getReel` (:521) and `getUserReels` (:2531), but `{error:'Reel not found'}` in 12+ other handlers, so reel existence is distinguishable from permission failure in those; posts return `{error:'Post not found'}` everywhere (post.controller.ts:2104, 2279, 2394, 2558, 2744, ...; one `resource_unavailable` at post.controller.ts:~1420). Mixed anti-enumeration posture.
- Type: BUSINESS-RULE. Risk: Med. Confidence: High.

##### B-R14 Premium entitlement spread: boost vs profile boost vs feed
- premium-post-boost.service.ts:14-25 `entitlementWindow` calls `getPremiumAccessSnapshot` AND re-reads `subscriptions` (two sources of truth for period start/end); throws string errors `'PREMIUM_REQUIRED'`. Feed author priority (`author.isPremium`, `profileBoostActive`, `discoveryPriority*35`) in feed-algorithm.service.ts:~262 `authorPremiumVisibilityScore` (+700 premium, +1800 boost) is a second premium-ranking rule alongside paid post boosts (position 9 insertion), and v2 has `premiumTieBreak` capped weight (feed-ranker.ts) - premium is a tie-breaker in v2 but a large additive in legacy.
- Boosted placement checks only `blockedAuthorIds` passed by the caller; eligibility `visibility = 'public'` literal (premium-post-boost.service.ts:66,206) and ignores author `isBanned` unless the pause SQL ran first (B-E1).
- Type: BUSINESS-RULE. Risk: Med. Confidence: Med.

##### B-R15 Collaborator state dual-written
- post.controller.ts:1836-2017 `respondToPostCollabInvite` writes both `postCollaborator` table and `metadata.pendingCollaboratorIds/collaboratorIds` (JSON) in one tx; createPost (:1627-1642) writes table rows AND `metadata.pendingCollaboratorIds`; utils/post.util.ts:395-440 `mapPostResponse` merges metadata pending + legacy `collaboratorIds` (only when no rows) + rows. `canViewPost`/`buildPostVisibilityWhere` read only the table. Invitees can accept regardless of block state (no `assertUsersCanInteract` or `canViewPost`).
- Type: BUSINESS-RULE/DATA. Risk: Med. Confidence: High.

### Slice C - Social & messaging

##### BR-1. Block enforcement is applied inconsistently (HIGH)
Blocked pairs should not see/act on each other. These slice paths do NOT call `getBlockedUserIds`/`areUsersBlocked`/`assertUsersCanInteract` (grep-verified: zero references in the file):
| Path | Location | Effect |
|---|---|---|
| Talk AI people search | `talk.controller.ts:360-407` `buildPeopleWhere`, `:559-603` | returns blocked users as candidates (no block, no existing-connection exclusion) |
| Talk profile preview | `talk.controller.ts:922-1170` | blocked viewer gets full preview |
| People you know (contacts) | `people-contacts.controller.ts:200-300` | matched users listed with no block/`isBanned` filter |
| Skill swap request, endorse, passport | `skills.controller.ts:1016-1102`, `:597-692`, `:84` | no `assertUsersCanInteract`; swap request/notification sent to blocked user. Only `isBanned` checked |
| Mutual info / follow counts | `follow.controller.ts:360`, `:469` | no block check, while follow lists (:239,:305) and status (:194) do |
| Nearby (location) | `controllers/location.controller.ts:110-175`, `services/discovery-power.service.ts:550-566` | SQL has no blocked exclusion; `people.controller.getPeopleNearMe` (:1192) does exclude |
| Group join paths | `groups.controller.ts:932`, `:1527` | no creator/member block check (invite path :1313 does) |
- Compare: connections (`assertUsersCanInteract` :120), follow (:51), chat (9 sites), group invite (:1210), profile (`areUsersBlocked`).
- Type BUSINESS-RULE. Recommended: one `visibilityGuard` (`assertCanView`, `excludeBlockedWhere(userId)`) used by every discovery/preview path. Risk HIGH (privacy/safety). Confidence High (absence verified by grep; semantic intent inferred from the other 20+ guarded paths).

##### BR-2. Unread-count rule diverges across 5 sites (HIGH)
All count `messages` with `receiverId = me, status != 'READ'`:
- `chat.controller.ts:417-428` (list): ALSO excludes `hiddenForUserIds has me`.
- `:730` (single conversation), `:841` (open conversation), `:1026` (sync): do NOT exclude hidden messages.
- `:1797` `getUnreadCount` (global badge): excludes messages from blocked senders, does NOT exclude hidden, and ignores `conversationId`.
- Per-conversation counts include blocked senders; the global badge excludes them; the conversation list hides blocked conversations entirely (:370, :1827 `unavailableConversationIdsForUser`). So badge total != sum of listed conversation counts.
- Mark-read (:1295 and `index.ts:1889`) marks hidden and blocked rows read too.
- Type BUSINESS-RULE. Future: `unreadWhere(viewerId, {conversationIds?, blockedIds})` single builder. Risk High (visible counters). Confidence High.

##### BR-3. "Accepted connection ids" implemented 6 ways
- `people.controller.ts:392` (take 1000, orderBy updatedAt desc, cached 30s, replica), `talk.controller.ts:209` (take 500, cached 30s, primary), `index.ts:455` (take 500, NO orderBy => arbitrary subset, no cache; drives presence rooms), `chat.controller.ts:1934-1950` `getMessageRequests` (unbounded, flatMap + delete self), `follow.controller.ts:375-400` (unbounded), `people-contacts`/`agent/tools` (unbounded, with all statuses).
- Behavior difference: a user with >500 connections can see different "connected" sets in presence rooms (index.ts) vs message requests (a connected peer past the cut shows up as a message request or loses presence).
- Type BUSINESS-RULE / DATA-ACCESS. Future: `connectionGraph.getAcceptedIds(userId, {limit})`. Risk Med. Confidence High.

##### BR-4. Connection status derivation (`none | pending_sent | pending_received | connected`) copied 8 times
- Shared implementation exists: `services/people-relationship.service.ts:17-83` (used only by `people.controller:442` and `proximity-history.service.ts:56`).
- Independent copies: `connection.controller.ts:143-146` (send), `:469`, `:958-966` (`getConnectionStatus`), `people-contacts.controller.ts:140-146`, `agent/tools.ts:870-878`, `talk.controller.ts:272-282`, `profile.service.ts:178-212` (raw SQL), `proximity.controller.ts:195` (filter set).
- Differences: `getConnectionStatus` and `profile.service` also map `status === 'blocked'` -> `'blocked'`, but nothing ever writes that status (dead branch; real blocks are in `user_blocks` and surface as 404 elsewhere). `people-relationship` adds `canMessage/canConnect` with a hard-coded 2-message stranger rule (BR-5). `getConnectionStatus` returns `direction`; others do not. `rejected` rows: `sendConnectionRequest` (:164-190) re-opens ANY existing row (including `rejected`) by overwriting `requesterId/addresseeId/status`, so a rejected requester can re-request immediately and the rejector can flip direction; this is a rule, not just a copy, and no cooldown is applied.
- Type BUSINESS-RULE. Future: single `deriveRelationship(row, viewerId)` + typed union shared with `types/profile.types.ts:63`. Risk Med. Confidence High.

##### BR-5. Stranger-message limit (2) is advisory, defined in 3 places, enforced nowhere in the send path
- `chat.controller.ts:1912` (`const limit = 2`, counts ALL messages ever sent to that user), `people-relationship.service.ts:54,75` (`< 2` per target, only when `includeActionLimits`), UI-facing message-requests logic (`getMessageRequests` :1927-2043 treats non-connected conversations as requests).
- Enforced path: `sendChatMessage` (`chat-message.service.ts:444-505`) runs only `assertUsersCanMessageCached` and `enforceTrustTierLimit(.., 'dm')`; no accepted-connection or "already sent 2" check (grep: no `connections` / `messages.count` in the service). Both REST `sendMessage` and socket `chat:send_message` go through it.
- Type BUSINESS-RULE. Recommended: constant `STRANGER_MESSAGE_LIMIT` + server-side enforcement in `sendChatMessage`, or delete the advisory endpoint if intentionally unlimited. Risk High (product rule not enforced) / Med for changing. Confidence Med (could be enforced by a DB trigger or client-only by design).

##### BR-6. REST vs socket chat behavior drift
- Send: socket (`index.ts:1807-1808`) records `recordActivity('message')` and `updateEngagementStreak('messaging')`; REST `sendMessage` (`chat.controller.ts:1193`) does not. Users who message via REST never earn message streaks.
- Edit: socket rejects `message.isDeleted` (index.ts:1976); REST `editMessage` (:1538-1640) has no `isDeleted` check, so a message deleted-for-everyone can be edited back into existence and a `chat:message_edited` event revives content.
- Delete/edit/react/mark-read: REST uses outbox + cache invalidation, socket does not (F4, F6).
- Message DTO: REST `mapMessagePayload` builds a `story` reference for `story_reply`/`story_reaction` (:271-300); service `mapChatMessagePayload` (used for realtime/ack of new messages) omits it. A story reply seen live has no `story` object until reload.
- Type BUSINESS-RULE. Risk Med-High. Confidence High.

##### BR-7. Group join / membership counter paths diverge
- Paths: `joinGroup` (:1527), `joinGroupByInviteLink` (:932), `respondToGroupInvite` accept (:1286), `respondToGroupJoinRequest` accept (:1433), `createCollegeCommunity`/`joinCollegeCommunity` (`college-communities.controller.ts:175,342`).
- "Already a member": `joinGroup` -> 400 `Already a member` (and does not test `creatorId`); other three -> 200 `already_member` and also test `group.creatorId === userId`.
- Private groups: `joinGroup` 403 "requires an invitation"; `joinGroupByInviteLink` converts to a pending join request (upsert, resets prior decision); invite accept joins directly.
- Capacity: `memberCount >= maxMembers` checked OUTSIDE the transaction in 4 places (:969, :1235, :1348, :1491, :1567), then `increment` in `$transaction`. Race: two concurrent joins at `maxMembers-1` both pass. Never re-checked.
- Counter: group paths use `increment/decrement` (:1013,1364,1507,1583,1641,2388). College community join sets `groups.memberCount = count(college_community_members)` (`college-communities.controller.ts:392-400`), i.e. overwrites the group counter with a different population; people who joined/left the backing group via `/groups/*` are not in that count, and `leaveGroup`/`removeMember` never touch `college_community_members`/`college_communities.memberCount`. College group also bypasses `maxMembers` (set to 10000, no check) and is `isPrivate: true` but joinable via `/groups/:id/join`? No: 403, so only the college route adds members, yet the owner row in `group_members` exists without a `college_community_members` row.
- Type BUSINESS-RULE. Future: `group-membership.service` (`addMember`, `removeMember`, capacity inside tx with conditional update `where memberCount < maxMembers`). Risk High (counter drift, over-capacity). Confidence High.

##### BR-8. Group slug: derived on every response vs persisted unique slug
- `groups.controller.ts` computes `slug: generateSlug(group.name)` at 9 sites (:257,307,419,498,560,616,811,1954,2067) and never persists it (`createGroup` :463 computes `slug` but omits it from `prisma.groups.create` data). Two groups with the same name return the same slug; `generateSlug` slices to 50, no fallback for empty result.
- `college-communities.controller.ts:46-65,239` persist a unique `groups.slug` using a different `slugify` (72 chars, uuid fallback, numeric suffix loop). For college groups the persisted slug != the slug returned by group endpoints.
- Third variant: `circles.controller.ts:47-77` (60 chars, `'circle'` fallback, suffix loop, excludes self).
- Type BUSINESS-RULE / FUNCTIONAL. Risk Med (deep links/lookup by slug break). Confidence High. Note `getGroup` (:523-531) resolves by `id` OR case-insensitive `name` (non-unique) via `findFirst`, so ambiguous when names collide.

##### BR-9. `profileBadgeStyle` gating applied in some DTOs, raw in others
- Gated (shown only if premium, or `student` badge with trust >= `STUDENT_VERIFIED`): `chat.controller.ts:185-199`, `chat-message.service.ts:220-237`, `services/user-response.service.ts:59-80` (profile header).
- Raw `profileBadgeStyle ?? null`: `groups.controller.ts:243-252` (`mapUser`), `people.controller.ts:507-535` (`mapUserToPersonCard`; has premium info available but does not apply it), `people-contacts.controller.ts:274`, `connection.controller.ts` 9 select sites, `social-proof.service.ts:78,264`, `location.controller.ts:152`. A user who lost premium still shows the premium badge in people/groups/connections lists but not in chat.
- Type BUSINESS-RULE. Future: single `publicBadge(user, visibility)`. Risk Med. Confidence High.

##### BR-10. Location privacy rule differs by surface
- "Shown if `shareLocationPublic === true`": `people.controller.ts:525`, `profile.service.ts:712,1166` (owner always sees own), `public-discovery.service.ts:159,401`, `index.ts:498-509,2631`.
- "Eligible for nearby if `shareLocationPublic` AND `COALESCE(locationPermission,true)`": `location.controller.ts:126`, `discovery-power.service.ts:560`, `matching-engine.service.ts:256-262` (`locationPermission !== false`).
- `people.controller.getPeopleNearMe` (:1236-1241) and `getFilterOptions` (:1311) check only `shareLocationPublic` (no `locationPermission`), and match by free-text `contains` on city/location.
- `talk.controller.ts:~1095` returns raw `user.location` (selected :965) in the profile preview regardless of `shareLocationPublic` (and returns `profileRing` ungated); `profile.service` gates both. That is a privacy leak plus a cache sharing issue: the preview is cached per target (not per viewer, `getProfilePreviewCacheKey`), so any viewer gets the same payload.
- Type BUSINESS-RULE. Risk High (talk preview location/ring leak), Med otherwise. Confidence High for talk, Med for locationPermission semantics.

##### BR-11. Eligibility (banned/suspended/restricted) predicate differs by surface
- Proximity: `isBanned=false AND (safetyRestrictedUntil null or < now) AND (safetySuspendedUntil null or < now)` copied 5x: `proximity-encounter.service.ts:60-63`, `:76-79`, `proximity-history.service.ts:26-31`, `proximity-presence.service.ts:31-34`. Also `public-discovery.service.ts:220-223,583-587` (uses `lte` vs `lt`).
- People discovery, suggestions, same-college, near-me, talk, matching, contacts, skills: `isBanned: false` only (`people.controller.ts:771,792,915,1029,1116,1237`; `discovery-power.service.ts:577`; `talk.controller.ts:397`; `matching-engine.service.ts:585,663`). A suspended user (not banned) is hidden from Crossed Paths but still recommended everywhere else; the interaction itself is then rejected by `assertUsersCanInteract` (`target_unavailable` 404), which is a poor UX.
- Type BUSINESS-RULE. Future: `activeUserWhere(now)` Prisma fragment + raw-SQL twin. Risk Med. Confidence High.

##### BR-12. Denormalized counters: three maintenance strategies
- Connections: accept = outbox job that re-counts and `upsert`s authoritative `connectionsCount` (`connection-accepted-side-effects.service.ts:25-37`); remove (`connection.controller.ts:611-614`) = `updateMany decrement` for both users, NOT in the same transaction as the delete, no floor at 0, silently no-op if no stats row; block (`trust-safety.service.ts:648-665`) = full recount for affected users.
- Follows: `follow.controller.ts:62-76` increments with `upsert` in tx; unfollow (:140-168) `update decrement` in tx (throws if stats row missing -> tx rolls back -> 500).
- Read side: profile uses denormalized `userStats` (`profile.service.ts:753`), `getFollowCounts` (`follow.controller.ts:469-482`) does live `count`, so two endpoints can disagree.
- Type BUSINESS-RULE. Future: recompute helper `refreshUserGraphCounts(userId)` used by all three. Risk Med. Confidence High.

##### BR-13. Recommendation exclusion sets
- `people.getSuggestions` (:851-968): excludes self, passed targets, blocked, banned; does NOT exclude connected/pending/rejected in the query, it filters the page afterwards (`connectionStatusByUser.has`) while using `skip` pagination, so pages can shrink or come back empty while more exist; quota is spent on the page size.
- `matching.controller.ts` (:176-190, :277-292, :95-101): excludes ALL existing `connections` rows (any status, including `rejected`) + blocked + banned inside the query.
- `talk.controller.findRecommendedPeople`: excludes only self + banned.
- `matching-engine.buildMatchingCandidateWhere` (:643): takes `excludedIds` from caller; `getConnectedOrPendingUserIds` (:611) is a fourth variant that drops `rejected`.
- Type BUSINESS-RULE. Risk Med. Confidence High.

##### BR-14. "Online" definition
- `isOnline || lastActive < 5min`: `profile.service.ts:114`, `talk.controller.ts:911`.
- `lastActive < 5min` only: `engagement.controller.ts:473,623,717`.
- raw `isOnline` flag: `chat` userSelect, `people` person card, `people-contacts`, `index.ts:2155` (`sharedPresence ?? isOnline`).
- Type BUSINESS-RULE (minor). Risk Low. Confidence High.

##### BR-15. Request/invite status transitions are check-then-write in 4 places; connections accept is atomic
- Atomic: `connection.controller.ts:297` `updateMany where status='pending'` + count check.
- Non-atomic: `respondToSkillSwapRequest` (`skills.controller.ts:1104-1175`: `findFirst pending` then unconditional `update`, double-accept can create two sessions), `respondToGroupInvite` (:1286-1382), `respondToGroupJoinRequest` (:1433-1522), `cancelConnectionRequest` family (`:509-575`) mostly OK.
- Type BUSINESS-RULE / DATA-ACCESS. Risk Med. Confidence Med.

##### BR-16. Pagination bounds
- Unbounded `limit`/`page` from `parseInt(...) || 20`: `connection.controller.ts:636-637,702-703,773-774,872-873` (4 lists), `follow.controller.ts:235-236,301-302`, `profile.controller.ts:232` (page unbounded, limit capped 100). A request with `limit=100000` returns every row; negative values flow into `skip`.
- Bounded: `groups.controller.ts:1669-1670` (50), `people.controller` (`parseBoundedInt`), `chat` (`clampPageSize`). Pattern also in 8 other controllers outside slice.
- Type INFRASTRUCTURE / BUSINESS-RULE. Future: one `parsePage(req, {defaultLimit, max})`. Risk Med. Confidence High.

##### BR-17. College name normalization (4 rules)
- `social-proof.service.ts:31` (`trim().toLowerCase()`, no whitespace collapse, null for empty; used for `sameCollege`), `college-communities.controller.ts:30-36` (collapse whitespace, 160 chars), `college-catalog.service.ts:208-215` (collapse, 120 chars), `identity.controller.ts:53` (collapse, no cap).
- Effect: a verified-student college key, a community key and a "same college" notification can disagree for strings with inner double spaces or >120 chars. Future: one `normalizeCollegeKey`. Risk Low-Med. Confidence High.

### Slice D - Notifications & infra

##### B-1. Push is sent even when the in-app notification was suppressed (self / blocked) - 16 of 23 sites
- createNotification (notification.service.ts:314-351) returns false when `actorId === userId` or `areUsersBlocked(actorId, userId)`. It is the ONLY place the self/block rule lives in this stack.
- 7 methods honor the result: `if (!notificationCreated) return;` at notifyPostComment 1143, notifyCommentReply 1180, notifyPostLike 1213, notifyPostShare 1245, notifyReelLike 1397, notifyReelShare 1513, notifyReelViewMilestone 1550 (count verified by grep: 7).
- The remaining push sites ignore the boolean and call sendToUser unconditionally: notifyMention 1295-1315, notifyPostCollabInvite 1337-1355, notifyReelComment 1434-1449, notifyReelCommentReply 1477-1492 (these 4 have an actor and can be self/blocked), notifyIdentityVerificationApproved/Resubmit 656-715 (no actor, fine), notifyHackathonTeamMatch 736-759, notifyHackathonTeamApplication 823-847, notifyHackathonTeamApplicationAccepted 863-887, notifyNewHackathonMatch 781-806, notifyHackathonWeeklyDigest 901-920 (no actor), notifySkillEndorsement 935-957, notifySkillSwapRequest/Accepted/Completed 984-1080, notifyCollegeCommunityJoined ~1083-1120.
- Concrete failure: user A blocks B; B comments on A's reel (`notifyReelComment`): in-app row correctly not created, but A still receives a push containing B's name and comment preview. Same for self-mention (`notifyMention` with mentionedUserId == mentionerId pushes to self) and for hackathon/skill actions between blocked users.
- Also: follow.controller.ts:94-110 and connection.controller.ts:197-209 push unconditionally and independently of `notifyFollow`/`notifyConnectionRequest` outcome (block is likely checked earlier in those controllers - follow.controller.ts:194/239/305 use areUsersBlocked for reads; confirm on writes - not verified).
- Type: BUSINESS-RULE (same rule "don't notify self/blocked actors" implemented for in-app only; push path has no rule). Consolidation: move guard into a single `deliver()` that gates both channels; push service should never be the layer deciding. Risk Med. Confidence High (code evidence direct).

##### B-2. Chat push: block + staleness rules exist only on the outbox/worker path
- workers/index.ts:107-149 (`processNotificationDelivery`): drops chat push older than CHAT_PUSH_MAX_AGE_MS (24h) and skips when `areUsersBlocked(senderId, userId)` before `pushNewMessage`.
- services/chat-message.service.ts:686-720 (`pushDeliveryMode === 'direct'`): calls `pushNewMessage` directly with neither check (fire-and-forget; only logs failures).
- Group chat: controllers/groups.controller.ts (`pushGroupMessageToUsers` at chat-message.service.ts:2634 and index.ts) pushes to all `group_members` with no block filter and no per-member mute; worker `kind==='group_message'` path (workers/index.ts:151-163) also has no block/stale check.
- Difference: same user-visible event, two delivery modes, different suppression rules. Block is probably enforced at message-send time (assertUsersCanInteract, index.ts), which makes the worker check a belt-and-braces; but a block created between enqueue and delivery is honored only in outbox mode. Severity depends on pushDeliveryMode default (not in slice).
- Consolidation: shared `shouldDeliverChatPush(payload)` used by both. Risk Low-Med. Confidence Med.

##### B-3. Unread count: three different rules
- controllers/notifications.controller.ts:143-165 (the live route /notifications/unread-count): `count()` of unread, excludes notifications whose actor is in the user's blocked set, does NOT collapse duplicate connection_request rows.
- notification.service.ts:1655-1679 `getUnreadCount` (NO callers - dead): fetches all unread rows, collapses duplicate connection_request per actor (`collapseInboxNotifications` 292-308), does NOT exclude blocked actors, caches 15s under tag `notifications:${userId}`.
- Inbox list (controller:73-130): excludes blocked actors AND collapses duplicate connection_request (fetches `limit*3` capped 150, +1).
- Concrete divergence: a user with 3 unread connection_request rows from the same actor sees badge=3 (live count) but 1 entry in the list. The service version would return 1 but ignores blocks. Neither equals the list.
- Also `markAsRead` (service 1571-1622) marks ALL connection_request rows of the same actors as read (so collapsed duplicates clear together) - consistent with list collapsing but not with the count.
- Type: BUSINESS-RULE. Consolidation: one `buildInboxWhere(userId)` + one count function; delete dead getUnreadCount or make the controller use it. Risk Low (count only). Confidence High.

##### B-4. "Recently notified" cooldown/dedup rules differ across match notification paths
- match-availability-notification.service.ts:
  - `notifyUsersAboutMatchAvailability` 267-271 / loadRecentlyNotifiedRecipients 140-159: per (actor=subject, recipient) pair, window = `getMatchNotificationCooldownHours()` (matching-engine config).
  - `runHighQualityMatchDigest` 324: skip if the recipient got ANY `recommended_match` in the last 20h (hardcoded `20 * 60 * 60 * 1000`, variable misleadingly named `oneDayBoundary`), THEN 352-358 re-checks the per-pair cooldown (cooldown env hours).
  - So a recipient can receive at most 1 digest/20h but unlimited availability notifications from different subjects (cap only by maxRecipients per subject); and the instant path never checks the per-recipient 20h rule.
- reengagement-notification.service.ts uses a completely separate dedup (table reengagement_notification_deliveries unique per user/date/slot, 1118-1167) with no awareness of recommended_match pushes sent the same hour; a user can get a reengagement nudge + digest + instant match within the same hour. No global per-user push rate cap exists (grep: none).
- notification.service.ts profile-view batching (373-490) is a third dedup scheme (3-day window, 15 viewers per batch).
- Type: BUSINESS-RULE (notification frequency rules, 4 independent schemes: pair cooldown, 20h per-recipient, per-slot delivery row, 3-day profile-view batch). Consolidation: central `notificationFrequencyPolicy` (per-user daily cap by category). Risk Med (product decision). Confidence Med.

##### B-5. "Eligible user" rules re-implemented 3 ways for push campaigns
- reengagement: runReengagementCampaign 1256 via `getEligibleAudienceWhere` (791-807: lastActive OR created within lookback, has active device token, `isBanned:false`, `isOnline:false`) vs previewReengagementForUser 1002-1026 (same rules as an if/else chain; separate code, must be hand-kept in sync; the campaign `select` at 1258-1291 omits `isOnline` yet casts rows `as UserSnapshot` at 1309).
- match digest: runHighQualityMatchDigest 305-325: any user with an active device token (`distinct userId`), skip banned, no lookback window, no `isOnline` rule, one user at a time sequentially (no batching) - contrast reengagement batches of 8 with allSettled and match-instant batches of 10.
- Active device-token check written 4 times: reengagement 799-803 (relation filter), 864-874 (findFirst), match-availability 305-309 (findMany distinct), push-notification.service.ts:179-182 (findMany isActive) which is the actual send path.
- No rule anywhere filters blocked pairs when choosing the "best match" candidate: reengagement findBestMatchCandidate 687-789 excludes only already-connected users (any connection status, via loadConnectedIds 664-685) and banned users; it ignores trust-safety blocks (areUsersBlocked / getBlockedUserIds). Match engine (`getConnectedOrPendingUserIds`, matching-engine.service.ts) is used by match-availability but whether it excludes blocks was not verified here.
- Consolidation: one `getPushAudienceWhere()` and one `hasActiveDeviceToken` helper. Risk Low-Med. Confidence Med-High.

##### B-6. Fixed-window vs sliding-window rate limiting (two algorithms, same purpose)
- services/rate-limit.service.ts: sliding-window-counter via Lua (INCR current + weighted previous window), memory fallback, "emergency" memory buckets; used by route middleware.
- infrastructure/cache/redis-cache.service.ts:555-604 `incrementFixedWindow` (MULTI incr+pttl then pexpire; memory fallback): used by services/ai-rate-limit.service.ts:128 and controllers/ai-chat.controller.ts:432 via cacheService (31 files import cacheService).
- Behavior differences: fixed window permits up to 2x burst across a window boundary; sliding counter does not. Redis failure: fixed-window falls back to per-process memory (per-instance limits multiply by instance count) unless cache role required, in which case it throws (handleRedisError); sliding limiter has its own emergency policy. The INCR then conditional PEXPIRE is not atomic (crash between leaves a key without TTL; mitigated because key includes windowIndex).
- Type: BUSINESS-RULE/INFRASTRUCTURE. Consolidation: only if product wants identical AI limits; otherwise INTENTIONAL (see N-4). Risk Med. Confidence Med.

### Slice E - Premium & admin

**B1. "Is this user premium?" defined in at least 4 ways; admin treated as premium inconsistently** (BUSINESS-RULE)
- Canonical: premium-access.service.ts:420-450 (non-legacy provider, not cancelled, `currentPeriodEnd > now`, plan in {premium,creator_pro}, status in {active,captured,authorized} at :51). `trialEndsAt` and any grace window are never consulted (always written null: razorpay.service:~218, access.service:~500, google-play:~452).
- Re-implementations / divergences:
  1. admin-premium.controller.ts:384-392 filter `premium`: `plan: 'premium'` exact + status in list, ignores `currentPeriodEnd`, `cancelledAt`, legacy provider, creator_pro (plan name configurable via env: access.service:190-196). List page filter therefore disagrees with the `isPremium` flag it renders on the same rows (:479). Overview counts use the canonical function (:231-241).
  2. Admin-as-premium: `isAdmin || premium` hand-rolled at tier-limits.service.ts:39,74,89; discovery-power.service.ts:160-166; premium-feature-gates.service.ts:57; premium-visibility.service.ts:329-340 (profile boost); skills.controller.ts:492-493; ai.controller.ts:33. NOT applied in: `snapshot.isPremium` itself, premium-post-boost.service.ts:19 (admin gets `PREMIUM_REQUIRED` for post boosts but may activate profile boosts), premium-visibility `getPremiumVisibilityByUserIds` (:190-260: admin gets no premium badge/ranking priority), managed-ad.service.ts:401-405 (admin not in `premiumStates` targeting), chat badge logic (chat.controller.ts:190-196). ~7 sites use the admin-OR rule, ~4 do not.
  3. Lean vs full snapshot: tier-limits.service.ts:26-40 loads a minimal subscription select, others call `getPremiumAccessSnapshot` (extra `agent_messages.count` at access.service:604-617 on every limit check for project/hackathon limits).
- Identical behaviour? No. Concrete failure: admin list filtered to "premium" misses creator_pro, expired-but-status-active and cancelled-in-future rows differently than the badge shown.
- Recommendation: one `resolvePremiumEntitlement(user, subscription, now): {isPremium,isCreatorPro,isAdmin,hasEntitlement}` + a Prisma `activePremiumWhere(now)` fragment used by admin filter/overview. Decide explicitly whether admins get premium visibility/boost. Risk High (entitlement). Confidence High.

**B2. Admin user list re-implements the premium snapshot with different numbers** (BUSINESS-RULE)
- A: admin-premium.controller.ts:436-537 (list) vs premium-access.service.ts:553-640 `getPremiumAccessSnapshot`; detail view (:832-1035) uses the snapshot.
- Differences:
  - creditsUsed window: snapshot = `currentPeriodStart` only while premium, else epoch (all-time) (:604-606); list = `currentPeriodStart || now-30d` even for expired/free users (:436-441) -> different "agent credits used" for the same user in list vs detail.
  - premiumDisplayAmount: snapshot uses `subscription.amount` when active, creator-pro default, override (:571-592); list uses override ?? default only (:480-483), so a paid-at-different-price user shows the wrong amount.
  - canCancelPremium: snapshot `provider !== 'google_play' && (isPremium || razorpaySubscriptionId)` (:600-601); list `canCancelPremium: isPremium` (:536) -> list offers cancel for active Google Play subs, and `cancelPremiumAdminUser` (:649-715) then happily revokes a Google Play sub locally (provider keeps billing the user).
  - isCreatorPro not exposed in list.
- Recommendation: batch variant `getPremiumAccessSnapshots(userIds)` in the service; list maps it. Risk Med. Confidence High.

**B3. Entitlement-change cache invalidation is applied in some write paths only** (BUSINESS-RULE)
- `invalidatePremiumEntitlementCaches` (premium-razorpay.service.ts:167-181; tags people/matching/feed/chat/user) is called by: razorpay activation (:331), controller Google Play verify (premium.controller.ts:779), user cancel (:840), profile boost (:348).
- NOT called by: `cancelPremiumAdminUser` (admin-premium.controller.ts:649-715), `updatePremiumAdminUser` overrides (:552-647: profileCustomizationGranted/Blocked, agentEnabled, price), `revokeLegacyTestPremiumSubscriptions` (access.service:529-551), post-boost state changes. Result: an admin revoke leaves premium visibility (discovery priority, badge, `people:user:*` caches) until TTL while user cancel clears immediately. Also the Google Play call site lives in the controller, Razorpay inside the service (placement inconsistency).
- Recommendation: put invalidation inside `cancelPremiumSubscription`/activation functions and the override upsert. Risk Med. Confidence High.

**B4. Cancellation / revocation semantics diverge by actor and provider** (BUSINESS-RULE)
- `cancelPremiumSubscription` (access.service:484-527): sets `currentPeriodEnd = now` and `cancelledAt = now`, status `cancelled` (user) or `revoked` (admin). So a user cancel forfeits the already paid remainder (no "access until period end"), whereas Google Play validation explicitly accepts `SUBSCRIPTION_STATE_CANCELED` and `IN_GRACE_PERIOD` with future expiry (google-play-premium.service.ts:277-286) -> same product, two different cancel semantics.
- Admin cancel additionally writes override rows `agentBlocked:true, profileCustomizationBlocked:true` (admin-premium.controller.ts:667-680); user cancel does not. Any later purchase clears these (`user_feature_access_overrides.updateMany` in razorpay.service:~268 and google-play-premium.service.ts:~470), so an admin revoke is undone by re-buying (probably unintended for abuse cases).
- `canCancelPremium`/`autoPayEnabled` key off `razorpaySubscriptionId` (access.service:600-602) but every Razorpay activation writes `razorpaySubscriptionId: null` (razorpay.service providerFields) - recurring path is vestigial; one-time orders only.
- Recommendation: define one lifecycle table (active -> cancelled(access till end) / revoked(immediate) / expired) in service; admin and user flows call it with `{immediate:boolean}`. Risk High. Confidence Med-High.

**B5. Payment finalisation differs between Razorpay and Google Play; no refund / renewal reconciliation** (BUSINESS-RULE)
- Razorpay: services/premium-razorpay.service.ts:186-335 - validates order+payment (premium-checkout.service.ts:126-199 incl. refunded/partial refunds, amount, currency, plan, cycle, user), per-user advisory lock + CHECKOUT_VERIFIED event as idempotency key (:148-165, :255-262), period = `now + durationDays`, writes actual paid amount, then cache invalidation.
- Google Play: google-play-premium.service.ts:375-521 - no lock, no idempotency key (re-verify rewrites row and appends another CHECKOUT_VERIFIED event each call), period taken from Google (`startTime/expiryTime`), `amount` = `planConfig.amountMinor` from the snapshot (includes admin price override / default price, not what Google charged) and plan always `getPremiumPlan()` (never creator_pro; will downgrade a creator_pro Razorpay row if a user verifies a Play token), cache invalidation done by the controller (premium.controller.ts:779).
- Revenue: admin-premium.controller.ts:204-213 sums `amountMinor` of CHECKOUT_VERIFIED events across providers -> Google Play revenue is plan price, not settled amount; repeated verifies double count. MRR (:230-246) sums `subscription.amount` for razorpay|google_play.
- Status transitions: only `active`, `cancelled`, `revoked` are ever written; no `refunded`/`expired`/`on_hold` writes. Razorpay refunds are only rejected at activation time (checkout.service:186-192), there is no refund webhook (webhook handles payment.captured/order.paid only, premium.controller.ts:630-730), and Google Play has no RTDN/cron sync (grep: no scheduler references google_play; cron.service.ts lists no premium job) so refund/chargeback/hold/renewal never update the row; access simply lapses at stored `currentPeriodEnd`. Razorpay re-purchase while active (premium -> creator_pro upgrade is allowed, premium.controller.ts:417) resets the period to `now + duration`, discarding remaining time.
- Recommendation: shared `applyActivation(provider, ...)` that owns lock, idempotency key, override-unblock, event write, cache invalidation; Google Play sync job; refund webhook -> revoke. Risk High. Confidence High (code facts), Med (intent).

**B6. Quota/limit enforcement: constants vs copy, windows, bypass** (BUSINESS-RULE)
- Limits live in tier-limits.service.ts:4-7 (10 conn req/day, 3 hackathon applications/month, 3/10 projects) and discovery-power.service.ts:10 (20 suggestions/day) and trust-safety `ACTION_LIMITS` (env-tunable, trust-safety.service.ts:879-904). User-facing messages hard-code the numbers instead of the constants: professional-fields.controller.ts:931-933 ("up to 10", "up to 3"), hackathons.controller.ts:669 ("3 ... per month"); only connection.controller.ts:165 interpolates the constant. premium.controller.ts passes only `FREE_CONNECTION_REQUESTS_PER_DAY` to `getPremiumEntitlements` (:217,245,285,360) so other limits are not advertised from one source.
- Connection requests have TWO independent limiters: tier quota (connection.controller.ts:162, premium exempt, UTC day, counts `connections.createdAt`) and trust-tier rate limit (:174, applies to premium too, Redis window). Different error shapes/codes (`403 ...` vs 429 `trust_tier_rate_limited`).
- Window metadata differs: `getConnectionLimit` (engagement.controller.ts:1277-1308) returns `resetsAt` even for premium (unlimited), suggestion quota returns `resetsAt: null` for premium (discovery-power.service.ts:171-185).
- Hackathon monthly limit counts only newly-created rows (`createdAt >= month start`, tier-limits.service.ts:96-103); re-applying to a previously rejected team goes through the `update` branch (hackathons.controller.ts:~702-715), keeps the old `createdAt`, and is never counted -> unlimited re-applications. Limit is also checked BEFORE the duplicate/pending check (:667 vs :680-692) so a free user at the cap gets 403 instead of the accurate 409 "already applied".
- Project and hackathon limits are count-then-insert without a transaction (race; professional-fields.controller.ts:928-942).
- Recommendation: `limits.config.ts` (single table, also feeds messages and entitlements) + `consumeQuota()` helper; count by "first application per team per month" or add an `appliedAt` field. Risk Med. Confidence High.

**B7. Streaks: 6 independent implementations, UTC vs local, freezes have no effect** (BUSINESS-RULE) - highest drift in slice
1. Daily Activity Streak: activity.service.ts:162 and progress.service.ts:415 (F1), UTC, from `userDailyActivity.isActive` (meaningful actions only; login excluded per STREAK_RULES progress.service.ts:34-38).
2. Per-category engagement streaks (login/connection/posting/messaging): engagement.controller.ts:1855-1927 `updateEngagementStreak` (UTC day; sets `longest*` and `best*` both to the same value, so two redundant columns; reads in `overallBestStreak` use `longest || best`, engagement.controller.ts:116-122, progress.service.ts:497-519).
3. Game play streak: arcade.service.ts:509-541 (`game_stats.currentStreak/bestStreak`, UTC), used as "streak" in games.controller.ts:239 leaderboard. Only arcade writes it; typing/trivia/wordle do not (games.controller upserts at ~1240).
4. Accountability pair streak: accountability.controller.ts:102-114 compares `toISOString().split('T')[0]` strings but builds "yesterday" with local `setDate(getDate()-1)`; read-then-update without lock (double check-in race increments twice).
5. Challenges: challenges.controller.ts:186-221 `currentStreak = bestStreak = number of active days in last 30` (not consecutive, `take:30`).
6. Wordle streak columns `wordleCurrentStreak/wordleBestStreak` are read (games.controller.ts:113-114) but never written anywhere in src (verified by grep) - always default.
- Freeze logic is inert: `streakFreezes` is bought (engagement.controller.ts:1638-1700, `COIN_COST = 100` hard-coded at :1646), shield toggled (:1707), and `processStreakFreezes` (engagement.service.ts:18-82) only decrements the counter; it never touches `lastXDate` or `userDailyActivity`, so the next `updateEngagementStreak` (:1893-1897, requires lastDate == yesterday) still resets to 1 and `calculateDailyActivityStreak` still breaks. Users spend 100 coins for nothing. `totalFreezesUsed: Math.max(0, 3 - streakFreezes)` (:149) is derived from a literal 3 and goes wrong after purchases.
- `resetBrokenStreaks` (engagement.service.ts:88-150), `sendStreakAtRiskNotifications` (:163-212) and `updateLeaderboard` (:218-278) are not referenced anywhere (only processStreakFreezes at cron.service.ts:46/135 and resetWeeklyCounters (no-op body, :297-305) are scheduled). Stored category streak counters therefore never decay to 0 server-side (the UI recomputes `isAtRisk`, engagement.controller.ts:73-77, but `getStreakLeaderboard` ranks stored values, :1752-1800, so stale streaks stay on the board). A parallel `streak_warning` campaign exists in reengagement-notification.service.ts (:345-352) with its own max-of-streaks rule (:258-275): third at-risk definition (>=3 here, `>= 2` freeze rule at engagement.service.ts:44, 1 in controller `checkAtRisk`).
- Timezone: comments say "midnight IST / 12:30 AM IST" (engagement.service.ts:13, 86, 161) but all day math is UTC and cron `0 19 * * *` (cron.service.ts:46) = 00:30 IST = 19:00 UTC, i.e. the UTC day is still open for 5 more hours when freeze/at-risk logic judges "yesterday".
- Recommendation: single `streak.service` (category + daily), explicit day-boundary policy, wire or delete the three dead jobs, decide freeze semantics (it must write a synthetic active day). Risk High (user-visible, paid coins). Confidence High.

**B8. Daily-window "today" differs: server-local vs UTC** (BUSINESS-RULE)
- games.controller.ts:203, 266, 423, 475 use `new Date().setHours(0,0,0,0)` (process local time) for `daily_trivia_sessions.date` unique key, daily wordle `usedOnDate`, leaderboard "daily" filter; everything else in the slice is UTC (E3). Admin dashboard (admin.controller.ts:527 `new Date(now.getFullYear(), now.getMonth(), now.getDate())`) is also local. On a non-UTC host (dev laptop vs Render UTC) trivia/wordle rotate at a different instant than streak/quota windows; if the host TZ is ever changed, existing keys no longer match (duplicate sessions). `getDailyWordle` assigns the word with find-then-update (:470-512) -> two concurrent first requests can consume two words.
- Recommendation: use the E3 util everywhere; unique-constraint-based claim for wordle. Risk Med. Confidence High.

**B9. Leaderboards: parameters computed but ignored; four different metrics** (BUSINESS-RULE / dead logic)
- games.controller.ts:191-250 `getLeaderboard` parses `gameType` and `period`, builds `dateFilter` (:201-209) and never uses either; always returns top `game_stats.totalXpEarned` all-time (take before filtering missing users, so fewer than `limit` rows possible; no `isBanned` filter, unlike engagement.controller.ts:955 which filters banned).
- Metrics differ: games = `game_stats.totalXpEarned` (arcade + typing, not trivia/wordle XP), arcade = `groupBy arcade_results` (arcade.service.ts:693-732), challenges = `userStats.xp` (challenges.controller.ts:150-168) vs lifetime XP being `max(userStats.xp, ledger)` (progress.service.ts:120-130), engagement = connection points (100/accepted, 20/pending; :869-1130). "XP" shown on three boards means three numbers.
- engagement.service.ts:218-248 builds `dateFilter` per period then ranks `userStats.connectionsCount` identically for weekly/monthly/alltime.
- Recommendation: either implement period filters from `xp_transactions` or drop the params; name boards by metric. Risk Low-Med. Confidence High.

**B10. XP / coin award rules vary per feature; trusted client input; weak idempotency** (BUSINESS-RULE)
- All use `awardUserProgress` (progress.service.ts:~240-300) - good - but with ad-hoc ratios: games/typing/arcade `coinAmount = xpAmount` (games.controller.ts:434-441, 634-641, 1216-1226; arcade.service.ts:579-589), learning lesson `max(5, floor(xp/5))` (learning.controller.ts:256-265), quiz pass `max(10, floor(xp/5))`, interview 10 coins flat if score>=75 (interviews.controller.ts:244-253).
- interviews.controller.ts:233-247 `completeSession`: `score` taken from request body (default 80), sessionId not looked up or ownership-checked, idempotency key `${userId}:interview_session_complete:${sessionId}` -> any new arbitrary sessionId string awards 45 XP + 10 coins + streak credit (unbounded farming). High. Confidence High.
- learning.controller.ts:309-322 failed quiz attempts: no idempotency key and `max(5, floor(xpReward/6))` XP each time (countsForStreak false) -> repeatable XP farm; passed attempts are idempotent per quiz.
- games: `xpReward` bounded server-side, arcade has `DAILY_REWARDED_MATCH_CAP` + same-opponent cap (arcade.service.ts:466-494); typing/wordle/trivia rely on per-id idempotency only; no daily XP cap comparable to `MESSAGE_DAILY_XP_CAP` (progress.service.ts:~46).
- store.controller.ts:196-225 "already owned" is a non-atomic pre-check but backed by fixed idempotencyKey -> OK; two controllers map error by string `'Not enough Coins'` (store.controller.ts:242, engagement.controller.ts:~1692).
- Recommendation: `rewards.config.ts` (xp, coin ratio, caps per source), session ownership validation for interviews, idempotency for quiz attempts (key by attempt id or per-day cap). Risk High (economy). Confidence High.

**B11. Moderation actions implemented twice with different side effects** (BUSINESS-RULE)
- Direct admin endpoints (admin.controller.ts banUser :1061-1100, unbanUser :1102-1131, restrictUser :2368-2403, suspendUser :2405-2443, clearUserSafetyRestriction :2445-2480, deletePost :1247-1263) vs `takeReportAction` (:2766-2965) doing the same state changes.
- Differences:
  - ban: direct = invalidate auth status + revoke sessions + `invalidateUserProximity(id,'admin_ban')`; via report = invalidate + revoke, NO proximity invalidation (:2957-2961). restrict: direct invalidates proximity ('safety_restricted') and does not revoke; via report neither proximity nor revoke. suspend: neither path invalidates proximity; both revoke.
  - Existence/validation: banUser has no existence check (Prisma P2025 -> 500) and defaults reason 'Admin ban'; warn/restrict/suspend require `reason` (400); report path requires `adminNotes` + `reason`. Self-guard: ban and suspend (direct) reject self; restrict does not; report path silently skips when reported user == admin.
  - Content: direct `deletePost` hard-deletes (`prisma.post.delete`, cascades), report `CONTENT_REMOVED` soft-removes (`isActive:false`, comments -> '[removed by moderation]', messages `isDeleted`). unbanUser clears suspended/restricted until but leaves `safetyRestrictionReason`; clearUserSafetyRestriction clears it.
  - Transactions: report path wraps DB changes in `$transaction` with `recordSafetyEvent({tx})`; direct path does `update` then a separate `recordSafetyEvent` (audit row can be missing if second call fails).
- Recommendation: `moderation-actions.service.ts` (banUser, suspendUser, restrictUser, removeContent) used by both. Risk Med-High. Confidence High.

**B12. User-submitted report rules inconsistent across types** (BUSINESS-RULE)
- reports.controller.ts: shared `createReportWithSafety` (:61-135) is good. Per-type differences: self-report blocked only for users (`reportUser` :452); `reportPost`/`reportComment` (:145-275) allow reporting your own content (self-reports feed `reportedUserPriorReports`/auto-priority). Open-report de-duplication exists only in `reportChat` (:303-340); post/comment/user/group can be filed repeatedly (inflates counters at :70-73). `reportGroup` (:513-575) destructures no `blockUser` (cannot block-after-report, others can). Trust-tier limit applied centrally (:67) - fine. `getMyReports` pagination (:585-586) caps 50 vs admin lists uncapped (I3).
- Recommendation: move guards (self, dedupe, block option) into `createReportWithSafety`. Risk Low-Med. Confidence High.

**B13. Block / visibility rules not applied in this slice's social surfaces** (BUSINESS-RULE)
- Block-aware code (`getBlockedUserIds` / `assertUsersCanInteract`) appears in chat, connection, people, post, groups, matching... but NOT in: skills.controller.ts (`endorseSkill` :597, `createSkillSwapRequest` :1016, `getSkillSwapSuggestions` :804), hackathons.controller.ts (`applyToHackathonTeam` :638, respond :728), engagement.controller.ts (`getDailyMatches` :380, `getPeopleLikeYou` :520, `getHiddenGem` :646, `getNudges`, `getLeaderboard` :869, `getRecentJoins`), events.controller.ts (RSVP/attendee lists).
- reward-cards.service.ts:280-299 `loadBlockedUserIds` is misnamed: it excludes users with pending/accepted CONNECTIONS (+self) and never reads `user_blocks`, so blocked users appear in reward cards. Same pattern inline x3 in engagement.controller.ts (:394-417, :535-552, :655-671) and 4 mentions in matching.controller.ts.
- Skill swap requests need no connection and no block check, while endorsements require a connection (skills.controller.ts:630-639): asymmetric rule, a blocked user can still send swap requests.
- Recommendation: `getExcludedCandidateIds(userId)` = blocks (both directions) + existing relations + self + banned, used by all discovery surfaces. Risk High (safety). Confidence Med-High (verified absence by grep; callers upstream could filter).

**B14. Boosts: post vs profile entitlement, duration, credits** (BUSINESS-RULE)
- premium-post-boost.service.ts:10-27 `entitlementWindow` requires `snapshot.isPremium` (admins excluded, B1); credit window key = `${subscription.id}:${currentPeriodStart}` and 2 credits per window (:6); any re-purchase/cancel+rebuy creates a new `currentPeriodStart` -> new 2 credits (cancel then repurchase hands out more credits than one period; Med confidence, depends on pricing intent). Duration fixed 24h (:7). Profile boost: premium-visibility.service.ts:327-397, duration configurable & clamped 1..24h (:353-355), admin allowed, supersede-then-insert, no locking (post boost uses `FOR UPDATE`, :72-77), so concurrent profile boost calls can create two active rows.
- Raw error codes leak to clients (`error: 'NO_BOOST_CREDITS'`, premium-post-boost.controller.ts:11-22); other premium endpoints use human messages + `code`.
- Recommendation: align entitlement + response shapes; lock profile boost. Risk Low-Med. Confidence Med.

**B15. Referrals and badges are stubs that look like rules** (BUSINESS-RULE / placeholder)
- referrals.controller.ts:40-56 `applyReferralCode` returns `{success:true, xpEarned:100}` without validating code, linking users or awarding XP; stats/list/leaderboard return zeros/empty (:58-120). Code = `VORMEX-<USERNAME6>-<last4 of id>` (:8-10), not unique-guaranteed or persisted. Nothing in auth signup consumes `ref`.
- badges.controller.ts:8-44 static array, `getMyBadges` etc. return constants; "Streak Master: 7-day login streak" is never evaluated. No real badge-awarding rule exists to consolidate; there are only student/verification badges elsewhere (chat.controller.ts:190-197).
- Recommendation: do not build abstractions yet; when implemented, award through `awardUserProgress` with idempotency `${referrer}:referral:${referee}`. Risk Low. Confidence High.

**B16. Event RSVP capacity race** (BUSINESS-RULE)
- events.controller.ts:508-560: count going -> compare to `maxAttendees` -> upsert inside a default-isolation transaction, then recompute `attendeesCount` by count. Two concurrent RSVPs at capacity-1 both pass. Counter is recomputed (self-healing) unlike increment-style counters elsewhere. Risk Low-Med. Confidence High. Fix: row lock on `campus_events` row or unique seat counter update `WHERE attendeesCount < maxAttendees`.

### Slice F - API, agent, discovery

Ordered by risk. "Socket" = index.ts handler; "REST" = controller.

**BR1. Agent `connections_accept_request` skips everything the real accept does** (HIGH)
- A: agent/tools.ts:1578-1670; B: controllers/connection.controller.ts:240-340 + services/connection-accepted-side-effects.service.ts:41-91.
- Real flow: guarded `updateMany where status='pending'` inside tx, outbox event; worker then `refreshConnectionCount` (recount), `recordActivity` x2, `recordAuthoritativeRecommendationOutcome(CONNECTION_ACCEPTED)`, `updateEngagementStreak` x2, realtime `connection:accepted` x2, in-app + push notification to requester, discovery cache invalidation.
- Agent flow: prior read then unguarded `update`, plus `userStats.connectionsCount: {increment:1}`, nothing else. Consequences: requester never notified; no streak/XP; no recommendation attribution; stale people/discovery caches; counter drift risk (increment vs recount; `removeConnection` decrements at connection.controller.ts:613).
- Recommend: agent calls the same service. Risk High. Confidence High.

**BR2. Agent `connections_send_request` bypasses trust/safety and notifications** (HIGH)
- A: tools.ts:1469-1577; B: connection.controller.ts:73-238.
- Missing in agent: `assertUsersCanInteract` (blocked/banned/suspended pair), `enforceTrustTierLimit('connection_request')`, receiver-exists check (bad userId = FK exception, not a "blocked" result), in-app + push notification, discovery cache invalidation, and re-request handling: REST re-opens an existing non-accepted/non-pending row via `update`; agent treats ANY existing row (including rejected) as "already_connected_or_pending". Both enforce `getConnectionRequestLimitState` (correctly shared).
- Recommend: shared `sendConnectionRequest` service. High / High.

**BR3. Agent `chat_send_message` writes `messages` directly** (HIGH)
- A: tools.ts:1724-1815 (+ `getOrCreateConversationForUsers` :994); B: services/chat-message.service.ts (REST chat.controller.ts:1205, socket index.ts:1771).
- Missing: `assertUsersCanMessageCached` (block check), `enforceTrustTierLimit('dm')`, message-request / daily limit handling (REST has `/chat/message-limit/:userId`, `/chat/requests`), `clientMessageId` dedupe, realtime fanout (recipient sees nothing live), push, cache invalidation, activity/streak. `chat_open_conversation` (tools.ts:1671) creates a conversation without `assertUsersCanInteract` or user-exists check (REST `getOrCreateConversation` chat.controller.ts:491-560 does both).
- The agent can message a user who has blocked the owner. Recommend: call `sendChatMessage`. High / High.

**BR4. Agent `groups_join` ignores private groups and capacity** (HIGH)
- A: tools.ts:1874-1993; B: groups.controller.ts:1527-1585 (`joinGroup`), :932 (`joinGroupByInviteLink`).
- REST: private group -> 403 "requires an invitation"; `memberCount >= maxMembers` -> 400 "Group is full"; `invalidateGroupListCache()`. Agent: none. Though `groups_discover` filters `isPrivate:false`, `groups_join` takes any LLM-supplied `groupId`, so it can join a private group directly, exceed `maxMembers`, and leave the list cache stale. High / High.

**BR5. Block + eligibility gaps in discovery** (HIGH)
- `getBlockedUserIds` is applied in people.controller.ts (577, 724, 899, 992, 1205), matching.controller.ts (95, 176, 277), chat presence index.ts:554-575, but NOT in: agent `people_search` (tools.ts:1114) and `matching_find_like_minded_peers` (:1298), talk.controller.ts `findRecommendedPeople` (:559), location.controller.ts `getNearbyUsers` (zero "block" references in file), surface-recommendation.service.ts, discovery-power `getNearbyDiscoveryUserIds` (callers apply it; function itself does not). Blocked users therefore appear in agent results, /talk cards and /location/nearby.
- "Who may appear in discovery" has several definitions: `isBanned:false` only (agent, talk, people, matching, location; 54 occurrences of `isBanned: false` in src); `isBanned` + `safetyRestrictedUntil`/`safetySuspendedUntil` expiry + web/ai opt-in + non-empty name (public-discovery.service.ts:133-146, 217-222); proximity services (own checks); recommendation-learning (own SQL). `safetyRestrictedUntil/SuspendedUntil` appears in only 12 files, none of people/talk/agent/location/matching, so a restricted/suspended user is hidden from public web/AI search but still returned by in-app discovery and agent. Product-decision flag. Risk High (safety/privacy). High that definitions diverge, Med that it is unintended.
- `GET /api/people` (routes/people.routes.ts:61, `optionalAuth`) serves cards to anonymous callers with `isBanned:false` only (discovery-power.service.ts:577), while `/api/public/discovery/people` enforces `webDiscoveryEnabled`. A user who opted out of web discovery is still returned by anonymous `/api/people`. Med confidence (may be by design).

**BR6. "Nearby people" defined 4 ways** (HIGH for agent variant)
| Impl | Viewer needs | Target conditions | Block | Radius |
|---|---|---|---|---|
| people.controller.ts:1192 `getPeopleNearMe` | `location` or `currentCity` string | `shareLocationPublic=true`, substring on city/location | yes | none |
| location.controller.ts:52 `getNearbyUsers` | lat/lng and `locationPermission !== false` | `COALESCE(locationPermission,true)` + `shareLocationPublic=true`, haversine | NO | 1-500km, default 50 |
| discovery-power.service.ts:527 (`radiusKm` on `/api/people`) | lat/lng | same as location.controller | caller does | 1-500km |
| agent/tools.ts:1167-1190 (`nearbyOnly`) | lat/lng on user row | NO `shareLocationPublic`, NO `locationPermission`; JS haversine over the 50 most recently active users globally | NO | none (sort only) |
- The agent variant exposes distance derived from coordinates of users with `shareLocationPublic=false`, and its candidate pool is the 50 most recently active users, not the 50 nearest, so results are arbitrary. High / High.

**BR7. Home vs surface recommendation: same rules, different constants** (MED)
- A: home-recommendation.service.ts:60-200; B: surface-recommendation.service.ts:29-180.
- COHORT_TRENDING trigger: home `likes+comments >= 3`; surface `viewsCount||attendeesCount > 0` (any viewed reel/event qualifies).
- EXPLORATION seed key: `explore:${user}:${id}` vs `${surface}:${user}:${id}` (different pseudo-random sets).
- relationship feature: home 1 / 0.85 / 0.45 (follow / connection / network-engaged); surface 1 or undefined.
- exploration feature: home `1 - logNormalize(impressions,1000)`; surface constant 1. quality feature: home from `recommendation_item_daily_stats`; surface always undefined.
- Feedback exclusion (NOT_INTERESTED / HIDE_AUTHOR): home filters both (home-recommendation.service.ts:104-105, also feed/feed-eligibility.service.ts:57-93); surface-recommendation (reels, stories, people, jobs, events) filters neither and none of those controllers references `recommendation_feedback`. "Hide author" therefore applies only to the home feed.
- Network membership: surface reads `connections accepted` + `follows`, each capped at 500; home uses viewer context lists (cap not checked).
- Recommend: unify candidate scoring; decide whether feedback is global. Med-High / High on differences, Med on intent.

**BR8. `DEFAULT_FEATURE_PRIORS` defined twice with different values** (MED)
- A: recommendation-engine.service.ts:51 (semantic .5, socialProof .25, cohortFit .25), exported, default arg for `scoreRecommendationCandidate` (:124) and `allocateCandidateSources` (:159); tests pin it (tests/recommendation-engine.service.test.ts:39).
- B: recommendation-model-serving.service.ts:11 (semantic .35, socialProof .20, cohortFit .30), non-exported, merged under DB priors at :51 and passed as `priors` by surface- and home-recommendation.
- Effect: with no `heuristic` row in `recommendation_models`, missing (`undefined`) features are scored with different priors depending on which path supplies priors. Same name, different value. Med / High.

**BR9. Socket and REST disagree on engagement/limits/notifications** (HIGH: clients may use either path)
Post comment: `post:comment` (index.ts:1581 -> :792) vs REST `createComment` (post.controller.ts:2538):
- REST: `enforceTrustTierLimit('comment')`; `assertUsersCanInteract` against the parent comment author on replies; `notifyPostComment`; `recordActivity('comment')`; recommendation outcome COMMENT; HTTP 400/404 codes; author select includes isVerified/profileBadgeStyle/identityTrustLevel.
- Socket: none of those. Blocked or rate-limited users can comment (and reply to people who blocked them) via socket; no persisted notification (only a live `notification:comment` envelope, lost if offline); `mentions` echoed from client payload unvalidated.
Post reaction: REST (post.controller.ts:2080-2250) notifies author (`notifyPostLike` + push outbox, only on brand-new reaction) and records recommendation outcome; socket (`post:react`/`post:like`, index.ts:1537-1580) does neither. REST visibility check reads outside the tx via `prismaRead`; socket inside the tx. REST `getPostRealtimeRooms` treats null visibility as public (`|| 'public'`, post.controller.ts:306); socket treats null as non-public (`|| ''`, index.ts:735/878/1043). REST cache tags from `feedCacheTags(...)`; socket hard-codes `['feed:global', ...]` (different tag set). Outbox event types differ (`post.like.fanout` vs `post.${eventName}.fanout`).
Comment realtime payload: REST sends the full comment only to `post:<id>` and counts-only to the feed room (post.controller.ts:2610-2625); socket sends the full comment with author to the global feed room for public posts (index.ts:880-890).
Reels: REST counters atomic `{increment/decrement:1}` (reels.controller.ts:1217-1245, 2019-2030); socket recounts `count()` and overwrites (index.ts:1090, 1174). REST reel comment increments parent `repliesCount` and stores `mentions`; socket does neither (reply counts drift for socket-made replies). REST notifies reel author; socket does not. REST `toggleLike` reads `reel.likesCount` that is not in its `select` (:1186-1190), so its initial fallback is always 0 (harmless).
Chat: socket `chat:send_message` calls `recordActivity('message')` + `updateEngagementStreak('messaging')` (index.ts:1805-1806); REST `sendMessage` (chat.controller.ts:1193-1240) does not, so streak/XP depends on transport. Socket `chat:delete_message|edit_message|react|mark_read` skip `enqueueRealtimeFanout`, `enqueueCacheInvalidation` and `invalidateChatCaches` that the REST versions run (chat.controller.ts ~1356-1375, 1583-1620, 1700-1760, 1347-1362): unread counts / conversation lists can stay stale after socket mark_read. Socket edit has no empty-content check (REST 400 "Content is required") and no length limit.
Story: socket `story:view` payload lacks `viewerId`/`timestamp` and never calls `invalidateStoryFeedCaches` (stories.controller.ts:574-645).
Group messages: socket enforces `allowGroupSocketAction` rate limit and rejects content > 8000 chars / fileName > 255 / groupId > 128 (index.ts:2268-2276); REST `sendGroupMessage` (groups.controller.ts:2503) has none (only global body size), so abuse controls are bypassed via REST.
Input limits/prompt injection: socket middleware (index.ts:1285-1315) uses `sanitizeInputTree` maxStringLength 4000 / depth 6 and rejects `containsPromptInjection` text for any event named `agent:*`, `*message*`, `*comment*` (DMs, group messages, post and reel comments). REST (`validateRequestInput`, middleware/input-validation.middleware.ts:25-55) allows 8000 chars / depth 8 and checks prompt injection only on /api/ai, /api/agent, /api/talk. The same DM text is accepted over REST and rejected over socket.
- Recommend: one service per aggregate; centralize limits/blocks/notifications/activity. Risk High. High.

**BR10. Profile image URL path vs upload path** (MED-HIGH)
- `POST /api/users/me/avatar|banner` (routes/profile.routes.ts:36-38, profile.controller.ts:683-830) accepts ANY string that parses as a URL: no host allow-list, no `mediaWriteLimit`, no image validation; writes directly to `users.profileImage/bannerImageUrl`. `POST /api/upload/avatar` (upload.routes.ts:96) goes through multer, `validateImageUpload`, sharp 400x400 WebP, Bunny storage, `invalidateProfileMediaCaches`.
- Cache tags differ: profile.controller emits `user:`, `people:user:`, `matching:user:`, `people:global`, `matching:global`; upload.controller.ts:139,216 emits only `user:<id>` (+ `invalidateProfileMediaCaches`). People/matching lists may show a stale avatar after upload but not after URL set. Recommend: pick canonical, add host allow-list, unify tags. Med-High / High.

**BR11. Free-tier AI quota enforced on only one of several AI entry points** (MED)
- `assistantChat` (ai-chat.controller.ts:960-1058) enforces `FREE_ASSISTANT_DAILY_LIMIT` (default 10/day, `consumeFreeAssistantQuota` :430). `careerChat` (:1059), the 7 helper endpoints, and `/api/talk/turn` (talk.controller.ts:798; general-mode chat via `aiService.complete`) have only per-minute AI rate limits. The "free 10/day" ceiling can be sidestepped via career-chat or talk. Rate-limit scopes are shared across unrelated products: agent sessions/turns/goals and `careerChat` share `'career-chat'`; assistant and `/talk` share `'talk'`. Intent unclear. Med / Med.

**BR12. Agent premium gate checked in 5 places with different failure shapes**: `requireAgentAccess` middleware (HTTP 403 JSON), socket `agent:voice_start` (index.ts:1396-1415, emits `agent:voice_error`), orchestrator.service.ts:790, realtime-voice.service.ts:925/1038/1152 (re-fetches `getPremiumAccessSnapshot` per turn), agent.controller.ts:49. Voice sockets have no equivalent of the HTTP `createAIRateLimitMiddleware` on agent routes (only the generic socket sanitizer; I did not trace throttling inside the realtime session). Med / Med.

**BR13. Agent `posts_create_text`, `profile_update_summary`, `notifications_mark_all_read` skip domain rules** (MED)
- tools.ts:2153-2239 vs post.controller.ts:1440-1700 `createPost`: agent lacks `enforceTrustTierLimit('post')`, `recordActivity`, realtime `post:created`, follower feed invalidation (`enqueuePostCreatedFollowerFeedInvalidation`), mention/notification handling. Visibility list `['public','connections','private']` is its own whitelist vs `parseVisibility` (mapping of 'private' not confirmed).
- tools.ts:2064-2152 vs profile controller update: direct `prisma.user.update` of headline/bio/interests, no validation pipeline, no cache/outbox invalidation.
- tools.ts:2374-2423 vs services/notification.service.ts:1627 `markAllAsRead`: agent sets only `isRead`; real path also sets `readAt` and enqueues `notifications:<id>` cache invalidation (stale unread badges, NULL readAt).
- `growth_get_snapshot` counts `post.count({authorId})` without `isActive:true` (tools.ts:2240+). Minor.
Med / High.

**BR14. Poll vote race window differs**: socket reads `existingVote` inside the tx (index.ts:1004-1010); REST reads it outside via `prismaRead` (post.controller.ts:2306-2314) then creates inside. Both do read-modify-write of `votes` in metadata JSON (lost update under concurrency). A DB unique index would turn a REST double-vote into a 500. Low-Med / Med.

## Data Access Duplication

### Slice A - Cross-cutting

##### D1. Block lookups: one canonical service, ~70 call sites with divergent usage shapes
- Source of truth services/trust-safety.service.ts: `getBlockedUserIds` 734 (cached, bilateral + device-scoped), `findBlockBetween` 696, `areUsersBlocked` 814.
- Callers: `getBlockedUserIds(` 39 sites in 20 files; `areUsersBlocked` ~30 sites in 11 files (profile 5, social-proof service 4, follow 4, groups 3, notification.service 3...). The not-in clause is hand-built 41 times: `blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}` with varying column names (authorId, id, actorId, userId, requesterId).
- Also two other block implementations outside the service: raw SQL `NOT EXISTS (... user_blocks ...)` in services/recommendation-learning.service.ts:65 and :153 (explicit blocks only; ignores `user_block_device_scopes`, so device-scoped blocks are not honored in recommendation cascades. Confidence High), and controllers/safety.controller.ts:53/177/207 (user-facing block CRUD).
- Response shape for "blocked" differs: `404 { error:'This resource is unavailable.', code:'resource_unavailable', retryable:false }` (follow.controller.ts:195, 240, 306; groups.controller.ts:1314; connection.controller.ts:707; reels.controller.ts:2531; stories.controller.ts getUserStories ~520; profile) vs `404 'Post not found'/'Reel not found'` via `canViewX` (leak-free) vs `403 user_blocked` via `assertUsersCanInteract`. The 'resource_unavailable' literal repeats 17 times in 8 controllers.
- Recommendation: helper `blockedExclusion(viewerId, column)` + constant `RESOURCE_UNAVAILABLE`. Risk Low-Med. Confidence High.

##### D2. Accepted-connection lookups: helper exists but used by few
- `areUsersConnected`/`getConnectedPeerIds` (access-control.util.ts:38/68) are consumed by access-control itself (8 refs) and stories.controller (2). Independent `status: 'accepted'` queries elsewhere: 8 controllers + 10 services (hackathons 8, engagement 8, groups 4, connection 3, chat 3, talk 2, skills 2, post 2, people 2, follow 2, agent/tools 3, profile.service 2, feed-viewer-context 2, public-discovery 2, ...). Many re-derive `OR [{requesterId:a,addresseeId:b},{requesterId:b,addresseeId:a}]` (e.g. chat.controller.ts:1884, 1938, 2053; connection.controller.ts:559, 941; agent/tools.ts:1498).
- Not all must be consolidated: list builders that already join (engagement leaderboards) are INTENTIONAL perf-specific; the pair-existence checks (chat 1884, connection 559/941) are duplicates of `areUsersConnected` except they do not normalize ids and use `prismaRead` vs `prisma` (replica lag vs primary: `sendConnectionRequest` reads primary, access-control reads `prismaRead`, so right after accept/reject a visibility check can lag).
- Recommendation: `connectionBetween(a,b)` and `connectedPeerIds(u)`; keep replica choice explicit. Risk Low. Confidence Med-High.

##### D3. Per-domain user select/mapper shapes (public user card)
Eight-plus near-identical field sets: post.controller.ts:127 (`postAuthorSelect`: id, username, name, profileImage, headline, isVerified, profileBadgeStyle, identityTrustLevel), reels.controller.ts:45 (same minus identityTrustLevel), chat.controller.ts:122 and services/chat-message.service.ts:127 (adds isOnline, lastActiveAt), safety.controller.ts:25, notifications.controller.ts:20 (actor select: no headline/trust), connection.controller.ts:101 inline, groups.controller.ts:243 `mapUser`, people.controller.ts:363, hackathons.controller.ts:110 `formatUser`, skills.controller.ts:64 `formatUserCard`, admin.controller.ts:160/2479/2508, plus 16 inline `select: { id, name, username, profileImage }` literals.
- Behaviour differences (user-visible): trust badge (`identityTrustLevel` / `publicTrustFields`) exposed in post authors, chat, blocked list; absent in reel comment authors, group members, notification actors, connection receiver. `verified`+`isVerified` duplicate keys only in groups/reel-comment mappers. `publicTrustFields` used in 5 files only. Mappers also differ in null handling (reel comment author has an 'Unknown user' fallback; others return null/throw).
- Recommendation: `PublicUserCard` select + `toPublicUserCard()` with explicit "variants" (basic, +headline, +presence). Risk Med (API shape stability for mobile clients). Confidence High.

##### D4. Transaction pattern "mutate + recompute counter + outbox/cache invalidation"
post.controller.ts comment delete (2850-2890), like toggle (~2100-2200), reels.controller.ts like/comment paths, groups join/leave, admin removal: counters are maintained three ways: recount (`count()` then `update({ commentsCount })`), `increment/decrement`, or not at all. Posts and admin group-removal recount; user group removal and reel comment parent `repliesCount` use decrement; reel `commentsCount` recount outside a transaction (reels.controller.ts:2250-2258). Mixed styles mean drift potential (decrement can go negative or drift; recount costs an extra query). Recommendation: pick recount-in-tx for denormalized counters or a shared `adjustCounter` helper. Risk Med. Confidence Med.

##### D5. Ownership comparisons `x.authorId !== userId` -> 403
~50 sites (professional-fields 13, reels 11, post 8, stories 3, connection 3, chat 3...). Messages vary per site ("You can only delete your own posts/reels/comments/stories", 'Only story owner can view viewers list', 'Not authorized'), all `403`, except non-owner reads of drafts which 404 via `canViewReel`. Ownership of a missing row returns 404 first everywhere checked. Consolidation would be a small `assertOwner(row.authorId, userId, message)`; value mostly in uniform error code. Risk Low. Confidence High.

### Slice B - Content

##### B-D1 `canViewX` loop-per-item N+1 on list endpoints
- saved.controller.ts:55-60 (`getSaved`: `canViewPost` per saved item -> `areUsersBlocked` + `connections.findFirst` per item, page size up to 50); reels.controller.ts:2604-2610, :2660-2666 (`getUserLikedReels`, `getUserSavedReels`: `canViewReel` per item); post.controller.ts:1720 (per mention recipient). Pagination is applied BEFORE visibility filtering in saved/liked/saved-reels, so a page can return fewer than `limit` items while `hasMore` is true, and `nextCursor` still advances past hidden items.
- Compare `buildPostVisibilityWhere`/`buildReelVisibilityWhere` which push the filter into SQL (used correctly in `getReel`, home feed).
- Type: DATA-ACCESS. Occurrences: 4 list handlers. Consolidation: filter in SQL (`posts: buildPostVisibilityWhere(userId)` on the relation). Risk: Low-Med. Confidence: High.

##### B-D2 "load entity -> canView -> 404" preamble
- Pattern `findUnique/findFirst(select authorId,visibility,...)` + `canView*` + 404: post.controller.ts x9 (2103, 2278, 2393, 2557, 2743, 2905, 2975, 2005, 1720), reels.controller.ts x17 (556, 608, 1195, 1308, 1383, 1525, 1817, 1878, 1980, 2171, 2345, 2418, 2607, 2663, 2730, 2964), stories.controller.ts x4 (595, 765, 929, 975), saved.controller.ts x3 (166, 225, 288), reports.controller (+1).
- Reel `select {id,authorId,visibility,status,publishedAt}` repeated 9x verbatim; post `select {id,authorId,visibility,isActive}` repeated 8x verbatim.
- Differences: post uses `prismaRead` (replica) for like/comment but `prisma` (primary) in saved.controller (:160, :219, :282); reels all primary; stories primary. Post `findFirst({where:{id,isActive:true}})` and then `canViewPost` also re-checks `isActive`.
- Type: DATA-ACCESS/INFRASTRUCTURE. Consolidation: `loadViewablePost(postId, viewerId, extraSelect)` / `loadViewableReel`. Risk: Low. Confidence: High.

##### B-D3 Ownership-check preamble
- post.controller.ts:1798-1802, :2043-2047 (`authorId !== userId` -> 403 "You can only edit/delete your own posts"), reels.controller.ts:1012-1015, :1087, :1152 (reel edit/publish/delete), stories.controller.ts:497-500, :672. Three phrasings, same rule; reels `deleteReel` hard deletes (cascades likes/comments/saves/shares) while `deletePost` soft-deletes (`isActive=false`, keeps comments/likes rows and then deletes media - restoring is impossible) and story delete hard deletes without media delete.
- Type: DATA-ACCESS/BUSINESS-RULE (delete semantics B-R13). Risk: Low. Confidence: High.

##### B-D4 Includes/selects for reel and story viewers
- `reelInclude` (reels.controller.ts:233-269) vs post `postResponseInclude`: same viewer-scoped "mine" relations pattern (`likes where userId`, `saves where userId`, `pollVotes where userId`) re-declared per domain (reel: `reel_likes/reel_saves/reel_poll_votes`; story: `story_views where viewerId take 1` repeated at stories.controller.ts:178,419,540 and `_count.story_views` x4). Story include for single/own/user/feed endpoints is copy-pasted 3x (:408-424, :523-541, :168-186).
- Type: DATA-ACCESS. Consolidation: `storyInclude(viewerId)`. Risk: Low. Confidence: High.

##### B-D5 Keyset/cursor pagination: 4 styles for the same job
- Signed HMAC keyset cursors (`utils/keyset-pagination.util.ts`): used by post (`feed.latest` post.controller.ts:1038-1043,1368), reels feed/hashtag/audio/user/liked/saved/drafts (applyDateCursor/encodeDateCursor reels.controller.ts:304-319 - a local wrapper pair duplicating `createdAtDescKeysetWhere`/`encodeKeysetCursor` usage).
- Raw record-id cursor `cursor:{id}, skip:1` (unsigned, stale-safe only if row exists): saved.controller.ts:51,117, reels `getComments` :1902, stories viewers :693, public-content-discovery.service.ts:151, post feed `dbCursor` :1188, audio/games controllers. If the cursor row is deleted/hidden (unsave, delete comment) Prisma throws -> 500.
- Offset (`page`/`skip`): post `getComments` (post.controller.ts:2380,2438 `skip:(page-1)*limit` + separate `count`), likes list.
- Composite "rec:" cursor encoding in feed-algorithm.service.ts:98-135 (`rec:<base>:<offset>:<sessionMs36>`; plain-text, unsigned, `safeCursorPart` regex) and `getRecommendationSessionPage` session cursors (unified).
- Limit clamping duplicates: `clampPageSize` (keyset util) used in reels; inline `Math.min(50, Math.max(1, parseInt(...)))` in post.controller.ts:2380, saved.controller.ts:28, reels :1861, stories :667 (`parseInt(...)||50`, **no max** - unbounded limit in `getStoryViewers`), post feed :1010-1014 (own clamp), story feed `parseStoryFeedLimit` (:82-86). Defaults: post 40/50, reels 10/30, comments 20/50 (post & reel), saved 20/50, viewers 50/unbounded, trending 20/50.
- Sort stability: reel comments order by `isPinned, likesCount, createdAt, id` with id-only cursor (reels.controller.ts:1897-1902): a like between pages reorders rows, so cursor-by-id with a mutable sort key can skip/duplicate; post comments use `createdAt desc` offset (unstable under inserts). Highlight-comment reorder (:1914-1941) slices `items` after reorder then derives `nextCursor` from `items[items.length-1]`, i.e. possibly the focused comment instead of the last DB row (cursor mismatch).
- Type: DATA-ACCESS/INFRASTRUCTURE. Consolidation: standardize on signed keyset for any user-facing list, `clampPageSize` everywhere. Risk: Med (client cursor contract changes). Confidence: High.

##### B-D6 Count-then-write counters
- `count()` + `update({count})` pairs: post.controller.ts:2127-2131, :2587-2591, :2766-2770 (comments like), :2837-2840; reels.controller.ts:1329-1336 (save), :2183-2189 (comment like), :2246-2252; stories.controller.ts:67-80, :887-891, :932-936. Occurrences: 11 sites in slice. All safe-ish self-healing but not atomic; 4 of them outside a transaction.
- Type: DATA-ACCESS (see B-R6 matrix). Risk: Low-Med. Confidence: High.

##### B-D7 Raw-SQL candidate pools repeating the same predicate
- services/feed/candidate-generators.ts:184-197 (college), :211-224, :244-257, :277-290, :315-329: five raw queries repeating `p.isActive = true AND p.visibility IN ('public','PUBLIC') AND p.authorId <> viewer AND p.authorId NOT IN (excluded) AND createdAt >= since` + (4x) `JOIN users u ... u.isBanned=false`. `postsByAuthors` (:65-88) is the ORM variant. Intentional per-pool shape, but the base predicate could be one `publicPostBase(viewer, excluded, since)` fragment (Prisma.sql). Note the uppercase `'PUBLIC'` is tolerated here while `public-content-discovery.service.ts:95` uses only `'public'` (posts are always lower-case via `parseVisibility`, so fine for posts).
- Type: DATA-ACCESS. Risk: Low. Confidence: Med.

##### B-D8 Repeated "viewer social graph" queries
- post.controller.ts:548-590 (connections take 500, follows take 500, profile_views), feed-viewer-context.service.ts:101-130, premium-post-boost.service.ts:193-199 (connections 500 + follows 500), reels.controller.ts:366-370 (`follows.findMany` unbounded for following feed; no take cap: a user following 50k accounts loads all ids into an IN list).
- Type: DATA-ACCESS. Consolidation: cached `getViewerGraph(userId)` already half-existing (viewer-context). Risk: Low-Med. Confidence: Med.

### Slice C - Social & messaging

- DA1. User card `select` repeated inline: `connection.controller.ts:106,257,260,655,658,726,729,819,884` (9x, identical 8 fields), plus `groups.controller.ts` `selectGroupUser` (:233) and 3 more inline selects (:1704,2451,2589), `chat` `userSelect` (:122), service `userSelect` (:127), `college-communities` `userCardSelect` (:9), `skills` `userCardSelect` (:13), `people` `personCardUserSelect` (:363), `people-contacts` inline (:222-243), `talk` inline (:564-583). ~25 hand-rolled shapes, differing by one or two fields each. Future: `selectors/user.ts` with `USER_MINI`, `USER_CHAT`, `USER_CARD`. Risk Low. Confidence High.
- DA2. Group + membership pair-fetch for authorization: `prisma.groups.findUnique(select id,creatorId,...)` + `prisma.group_members.findUnique(groupId_userId)` in `Promise.all` at `groups.controller.ts:1097/1098, 1154/1155, 1213/1214, 1403/1404, 1453/1454, 1620/1621, 2031/2032, 2161/2162, 2219/2220, 2285/2286, 2354/2355` (11x), then `hasGroupRoleAtLeast`. Also single `group_members.findUnique` at :713,1055,1845,2425,2521 and `index.ts:2181,2281`. Future: `loadGroupAccess(groupId, userId)` returning `{group, membership, role}`. Risk Low. Confidence High.
- DA3. Conversation participant check: `conversations.findFirst({ OR: [{participant1Id: me},{participant2Id: me}] })` at `chat.controller.ts:523,674,789,1114,1258,1277,1482,2115,2191` (9x) vs the cached `getConversationPeerIdCached` (`chat-conversation-cache.service.ts:41`) used by the service and `index.ts:665`. Also pair-lookup `participant1Id: a, participant2Id: b OR reverse` in chat :523 and `index.ts:2126`. Future: route controller checks through the service helper. Risk Low. Confidence High.
- DA4. Blocked-participant exclusion: `...(blockedUserIds.length > 0 ? { participantXId: { notIn: blockedUserIds } } : {})` pairs: 13 occurrences in `chat.controller.ts` (:370-374, 922-926, 950-954, 1800, 1833-1837, 1959-1963, 2076-2080 and others) plus `unavailableConversationIdsForUser` (:77) which fetches the same set a second time. Future: `conversationVisibleWhere(userId, blockedIds)`. Risk Low. Confidence High.
- DA5. Connection pair lookup `OR [{requesterId:a,addresseeId:b},{requesterId:b,addresseeId:a}]`: `connection.controller.ts` 6x, `chat.controller.ts:1884` + 3 more, `engagement` 5, `follow` 2, `skills.controller.ts:570` (`areConnected`), `talk` 2, `index.ts:2142`, `people-relationship.service.ts:59`, `matching-engine`. `connectionsBetween(a,b)` helper missing; `chat.getMessageLimitStatus` (:1884) is a literal `areConnected` copy.
- DA6. `isUUID(x) ? {id:x} : {username:x.toLowerCase()}` lookup: `profile.controller.ts` x4 (incl. `resolveProfileTargetId` :74, an extra query before every profile read that the service then repeats), `profile.service.ts` x3, `skills.controller.ts:94`, `talk.controller.ts:951`. 9 sites.
- DA7. Unread aggregation `messages.groupBy conversationId` (:417, :1026) and `messages.count` (:730, :841, :1797) (see BR-2).
- DA8. `userStats` upsert/update with counters: `follow.controller.ts:62-76, 150-165`, `connection.controller.ts:611`, `trust-safety.service.ts:648-665`, `connection-accepted-side-effects.service.ts:25` (BR-12).
- DA9. Redis client factories: `infrastructure/proximity/redis-client.ts:15-48` vs `infrastructure/redis/client.ts:77-130`: same shape (lazyConnect, connect/command timeouts, exponential `retryStrategy` 250*2^n, throttled error logging). See Intentional I3.

### Slice D - Notifications & infra

##### D-1. Notification include shape + formatter duplicated and already drifted
- notification.service.ts:64-88 `notificationInclude` + 90-101 `formatRealtimeNotification` vs controllers/notifications.controller.ts:19-60 `notificationInclude` + `formatNotification`.
- Drift: controller actor select includes `profileBadgeStyle`; service/realtime payload does not, so socket `notification:new` actor object lacks the badge field that the REST list returns. Formatter: REST adds `readAt`, realtime omits it.
- Consolidation: export one include/formatter from a notification mapper module. Risk Low. Confidence High.

##### D-2. Active device token queries (4 sites) - see B-5. Plus token deactivation only in push-notification.service.ts:265-269; the "no tokens" case does `console.log` and returns false, which reengagement records as `push_not_sent`/failed (1231) instead of "skipped no token" even though eligibility already required a token (race only).

##### D-3. Outbox enqueue sites: 3 near-identical `enqueueOutboxEvent` builders
- outbox/helpers.ts:9-75 (realtime/cache/notification helpers) vs inline calls in notification.service.ts:244-290 (`enqueueNotificationCreatedEvents`, `enqueueNotificationCacheInvalidation`) and 1612-1620, 1640-1648 (`notification.read`, `notification.read_all`, tags `notifications:${userId}` repeated 5 times). The service does not use `enqueueRealtimeFanout`/`enqueueCacheInvalidation` helpers (which also skip empty tags). Chat code uses raw SQL `INSERT INTO outbox_events` (chat-message.service.ts ~640-670) as a 3rd path with `ON CONFLICT (idempotencyKey) DO NOTHING`.
- Pattern count: >=3 distinct enqueue implementations. Consolidation: use helpers everywhere. Risk Low. Confidence High.

##### D-4. Reengagement growth-snapshot: 7 near-identical `groupBy` queries
- reengagement-notification.service.ts:514-590. Each is `groupBy authorId/senderId where {authorId in userIds, createdAt >= window}` with small variations (reels `status != draft`; messages/group_messages `isDeleted:false`; post/comments no soft-delete or isActive filter). Posts: no `isActive:true` filter although feed rules elsewhere use `isActive` (e.g. loadDocuments in recommendation-embedding.service.ts uses `isActive:true, visibility:'public'`), so deleted/hidden posts count as "meaningful growth". Possible rule drift; confidence Med (depends on soft-delete semantics of `post`).
- Also `loadUserSnapshotById` select (809-848) vs the inline select in runReengagementCampaign (1258-1291): same shape written twice, the latter missing `isOnline`.

##### D-5. GitHub/Hackathon upserts, slug, and `findUnique` loops
- hackathon-import.service.ts:168-179 `uniqueHackathonSlug` loops one `findUnique` per suffix (N+1 on collision); controllers/hackathons.controller.ts:58-75 has its own `slugify` + `uniqueHackathonSlug(title, startsAt)` (slug WITHOUT source prefix, vs `${source}-${title}-${year}` in import). Same function name in two modules with different slug formats; collisions between manual and imported hackathons are possible only via the unique `slug` constraint (loop handles it).
- `cleanText/cleanOptionalText/cleanList/slugify` triplicated: hackathon-import.service.ts:85-115,160; controllers/hackathons.controller.ts:34-65; controllers/college-communities.controller.ts:21-40; `normalizeText` x4 (talk.controller:131, matching-engine:195, premium-checkout:110, reengagement:238). cleanText differs: controller uses `ensureString(value)` (rejects arrays/objects), service uses `String(value || '')` (coerces objects to "[object Object]"); cleanList maxLen 48 vs 60; max 240 vs 280.
- Consolidation: `utils/text.util.ts`. Risk Low. Confidence High.

### Slice E - Premium & admin

**D1. Subscription select shape repeated** (DATA-ACCESS) - 5 sites select `{plan,status,provider,currentPeriodEnd,cancelledAt}` for `isPremiumSubscriptionActive`: tier-limits.service.ts:34, premium-visibility.service.ts:190-198, managed-ad.service.ts:371-380, admin-premium.controller.ts:162-170 and :422-432. Recommendation: export `PREMIUM_SUBSCRIPTION_SELECT` (type-checked against the predicate's Pick). Risk Low. Confidence High.

**D2. "Exclude existing connections" set** (DATA-ACCESS/BUSINESS) - engagement.controller.ts:394-417, 535-552, 655-671 (3x identical `connections.findMany OR requester/addressee` -> Set), reward-cards.service.ts:280-299, matching.controller.ts (4 refs), chat.controller.ts (6 refs). Note they fetch ALL connection rows of the user with no limit. Recommendation: one service (see B13). Risk Low. Confidence High.

**D3. Ownership check = `findUnique` then `row.userId !== userId -> 404`**: professional-fields.controller.ts update/delete for 7 entities (skill, experience, education, project, certificate, achievement, interest) = 14 handlers (e.g. :392-410, :512-530, :680-700, :803-822). Could be a single `deleteMany/updateMany({where:{id,userId}})` (atomic, one query). Risk Low. Confidence High.

**D4. Agent credit counting** - `agent_messages.count({userId, role:'user', createdAt in window})` in premium-access.service.ts:604-617, admin-premium.controller.ts:436-463 (groupBy variant) and :883-890 (detail). Window rule differs (B2). Risk Med.

**D5. Check-then-write patterns without transaction/unique claim**: project limit (professional-fields.controller.ts:928), hackathon application (:667-715), accountability check-in (:102-125), wordle daily word (games.controller.ts:470-512), store ownership (store.controller.ts:196-210, mitigated by idempotency key), conversation creation (admin-premium.controller.ts:85-106). Concurrency primitives used in the slice are inconsistent: pg advisory lock (razorpay), `FOR UPDATE` (post boost), Redis lock (arcade `withArcadeRoomLock`), none elsewhere. Recommendation: pick a per-domain pattern (prefer unique constraints/conditional updates). Risk Med. Confidence High.

**D6. Public user card selects**: `{id,name,username,profileImage,(headline)}` repeated in games.controller.ts:217-221, arcade.service.ts:~713, challenges.controller.ts:153-159, engagement.controller.ts:~955-965 and 1019+ (3x), skills.controller.ts `userCardSelect`, hackathons `formatUser`, admin-premium `chatUserSelect`. Low value individually; a `publicUserCardSelect` const would suffice. Risk Low.

### Slice F - API, agent, discovery

**D1. Accepted-connections query**: `where:{status:'accepted', OR:[{requesterId},{addresseeId}]}` + peer mapping. 61 occurrences of `status: 'accepted'` in 26 files across src. In slice: index.ts:455 (`take:500`, no orderBy), agent/tools.ts:838-930 `buildConnectionMetadata`, talk.controller.ts:209 (configurable cap, ordered, cached), surface-recommendation.service.ts:60 (`take:500`, prismaRead). Different caps, read clients, orderings. Recommend `getAcceptedPeerIds(userId,{limit})`. Low / High.

**D2. "Active post exists + canViewPost" guard** `findFirst({id,isActive:true}) -> canViewPost`: index.ts:693, 806, 925, 983, 1507; post.controller.ts:2095, 2279, 2555. Select shapes differ only by `metadata`/`authorId`. A `getViewablePostOrNull(tx,...)` helper would collapse them. Low.

**D3. Conversation participant lookups**: index.ts:646 `isConversationParticipant` (uncached `findFirst`) used in `chat:join` right before cached `getConversationPeerId` (:665); `markAsRead` (chat.controller.ts:1255-1290) loads the conversation twice (outside and inside the tx); `getOrCreateConversationForUsers` (tools.ts:994) is a third find-or-create (REST version adds user-exists + safety). Low.

**D4. Counter strategies mixed on the same columns**: socket paths `count()`-then-overwrite (index.ts:741, 833, 954, 1090, 1174, 2589); REST post paths also recount; REST reel paths atomic increment/decrement; agent uses `increment` for `connectionsCount` and `memberCount`. Paths on the same column (`reels.likesCount`, `reel_comments.repliesCount`, `userStats.connectionsCount`) can drift. Med.

**D5. Embedding calls**: SDK `embeddings.create` with `encoding_format:'float'` (public-discovery.service.ts:170, 12s, retry 1, warn-and-null) vs raw fetch (recommendation-embedding.service.ts:100, 20s, no retry, throws). Related to F6.

**D6. Group message setup**: `group_members.findUnique` + `groups.findUnique` with `group_members {userId != me}` select identical in index.ts:2282-2312 and groups.controller.ts:2517-2544 (part of F5).

**D7. Agent re-queries**: tools.ts:2316-2373 re-queries `notifications` (count + findMany) instead of `notificationService`; `growth_get_snapshot` re-implements 5 counts that exist elsewhere. Low value.

## Infrastructure Duplication

### Slice A - Cross-cutting

##### I1. Error-response envelope: four shapes
1. Controllers: `{ error: string }` (1524 uses), sometimes + `code`, `retryable`, `requestId` (22 controllers use `code:`).
2. `errorHandler` (middleware/errorHandler.ts:55-65): `{ status, message, requestId }` (uses `message` key, not `error`).
3. `authenticate`: `{ error, code, requestId, [requiresVerification] }` (auth.middleware.ts:208+); proximity router gets a nested `{ error: { code, message, retryable } }` (auth.middleware.ts:186-190; rate-limit.middleware.ts:208-215; proximity.controller.ts). Intentional for proximity API v1 (versioned contract), not a bug.
4. `validateRequestInput` rejection: `{ error:'Invalid request input', message }` (input-validation.middleware.ts:9-13): both keys; `requireAdmin` (admin.middleware.ts:14-35): `{ error }` with no code/requestId (except 2FA which adds `code`).
- Also success envelopes: `{ success: true }` (79; social-proof 51), `{ message }` (41; admin 14, stories 11), `{ status }` (8 in connection/groups, where `status` is data not envelope).
- A client must parse `error` OR `message` depending on layer. Recommendation: typed `ApiError` thrown from handlers + central serializer emitting `{error, code, requestId}`; leave proximity v1 separate. Risk Med. Confidence High.

##### I2. try/catch + `console.error` + generic 500 boilerplate (612 catch blocks)
- 506 `console.error('xyz error:', error)` vs request-scoped `getRequestLogger` in 5 places (auth/rate-limit/error middleware, ai controller, reports none). Result: most controller errors are unstructured stdout lines without requestId, while middleware errors are structured. 306 `status(500).json({ error: '<Failed to ...>' })` with per-handler strings; 16 use `{ success:false, error:'Request could n...' }`.
- Only reports.controller.ts:51 `handleReportError` and 28 `safetyErrorResponse` call sites map `SafetyActionError` -> `{statusCode, body}` uniformly; others rely on caller remembering to call it. Handlers that call `assertUsersCanInteract` but not `safetyErrorResponse` would turn a 403/404 safety error into a 500 (not individually audited; grep shows 11 controllers using the assert, 28 mapper calls).
- Recommendation: `asyncHandler(fn)` + central error middleware (map `SafetyActionError`, Prisma P2002->409, P2025->404, validation -> 400, else 500 with requestId). Would remove ~600 catches. Risk Med (behavioural parity of per-handler messages). Confidence High.

##### I3. Pagination parsing: ~10 incompatible idioms, several unbounded or NaN-prone
Helpers that exist: `clampPageSize(value, fallback, max)` (utils/keyset-pagination.util.ts:91; NaN-safe) used in only 3 controllers (chat, notifications, reels); `clampLimit` (data/growth-hub.catalog.ts:534; jobs, learning, interviews, challenges), `parseBoundedInt` (people), `parsePositiveInt` (admin-premium), `toPositiveInt` (events), `parseInteger` (admin-managed-ads), plus ~60 inline forms.
Verified defects of the inline forms:
- Unbounded `limit` (no max), user-controlled `take`: controllers/connection.controller.ts:637, 703, 774, 873; follow.controller.ts:236, 302; social-proof.controller.ts:264, 359, 404; engagement.controller.ts:1515; games.controller.ts:1100; admin.controller.ts:870, 1192, 1275, 1374 (admin-only). e.g. `?limit=100000` returns up to that many users. Contrast: groups/matching cap 50, profile 100.
- NaN limit: `Math.min(Math.max(parseInt(x || '20', 10), 1), 50)` yields NaN for `limit=abc` (Math.max(NaN,1) is NaN) -> Prisma `take: NaN` error -> 500: audio.controller.ts:164, 227 (+3 more audio sites with `(req.query.limit as string) || '20'`), post.controller.ts:2382, reels.controller.ts:1864, 2450, saved.controller.ts:29, 97. The `|| 20` idiom (`parseInt(...) || 20`) is NaN-safe but unbounded; negative values pass through `parseInt('-5') || 20 = -5` (Prisma negative `take` reverses direction).
- Page parsing: 7x `parseInt(ensureString(req.query.page) || '1') || 1`, 6x `Math.max(1, parseInt(...)||1)`, 5x `parseInt(req.query.page as string) || 1` (negative page -> negative `skip` -> Prisma error 500; admin.controller.ts:869, 1191, 1274; connection.controller.ts `(page-1)*limit`).
- Defaults vary for equivalent list endpoints: 10/20/30/50/100.
- INTENTIONAL exception: controllers/proximity.controller.ts:168, 189 strictly validates `limit` 1..50 and throws `ProximityValidationError` (versioned API, rejects rather than clamps).
- Recommendation: one `parsePagination(req.query, {defaultLimit, maxLimit})` returning `{page, limit, skip}` (NaN-safe, min 1, max enforced); keep keyset helpers for cursor lists. Risk Low-Med (changing clamps changes API behaviour for clients that rely on huge limits). Confidence High.

##### I4. Rate limiting: two parallel middleware implementations
- middleware/rate-limit.middleware.ts (`createRateLimitMiddleware`, multi-rule single Redis round trip, emergency fallback, proximity body shape) and middleware/ai-rate-limit.middleware.ts (`createAIRateLimitMiddleware` using `aiRateLimitService`). Duplicated: `x-ratelimit-limit/remaining/reset` + `retry-after` header setter (rate-limit.middleware.ts:36 vs ai-rate-limit.middleware.ts:6), 429 body `{error, code, requestId, retryAfterSeconds}`, `req.ip || req.socket.remoteAddress || 'unknown'` (3 places incl. abuse-protection botGuard), userId-vs-ip identifier derivation.
- Differences: AI limiter does not fail open/emergency-fallback; on service error it calls `next(error)` (-> 500) whereas the generic limiter falls back to in-memory emergency limiter for sensitive paths or fails open otherwise. A Redis outage therefore breaks AI endpoints but not others. Probably deliberate for cost control; confirm. Confidence Med.
- Per-route limiter definitions: `createRateLimitMiddleware` instantiated in 14 route files (admin 3, auth 5, verification 4, proximity 4, password 3, oauth 3 ...) with inline numbers; auth.routes.ts and verification.routes.ts define multiple IP/email/token tiers each with its own message strings.
- Recommendation: share header/429 helpers and identifier derivation; leave AI fail-closed behavior documented. Risk Low. Confidence High.

##### I5. Input validation/sanitization
- Global: `validateRequestInput` (middleware/input-validation.middleware.ts:21) sanitizes every `/api` query/body (index.ts:2826): max depth 4/8, string length 512 query / 8000 body, structural/markup injection checks. `validateMultipartFields` re-runs it for multipart (routes call it after multer in only some routes: chat, upload group routes; stories/post/reels not verified). `validateAIRequestInput` for AI paths (index.ts:2900-2902).
- Controller-level validation duplicates: per-controller manual checks of required fields (400 with varied text e.g. 'postId required', 'Post ID is required', 'Reel ID is required', 'userId required'), UUID/id presence checks, per-file `parseInt` helpers, `.slice(0, 5000)` description truncation x4 in reports.controller.ts (145-570), `normalizeOptionalString`/`trimmed`/`normalizeString` helpers redefined in admin.controller.ts, admin-managed-ads.controller.ts, others. No schema validator (zod/joi) in use in controllers (not grep-verified for services).
- The global 8,000-char body cap vs product limits (post/article content) is a risk surface, not a duplication; not pursued.
- Recommendation: shared `ensureString`/`requiredParam(req,'postId')` helper (utils/request.util.ts has only `ensureString`, 5 lines) and schema validation per route. Risk Low. Confidence Med.

##### I6. Email infrastructure (utils/email.util.ts)
- `sendEmail` (459) calls `ensureEmailServiceReady()` again although every caller (register auth.controller.ts:233, login 471, forgot-password password.controller.ts:100, resend verification.controller.ts:278) pre-checks it; the TTL cache (`EMAIL_SERVICE_CHECK_TTL_MS`) makes the second call cheap but the pre-check + error mapping is repeated 4x in controllers (`ensureEmailServiceReady` -> `toPublicEmailDeliveryFailure` -> `res.status(failure.statusCode).json(failure.body)`).
- `sendPasswordResetEmail` (513-617) and `sendVerificationEmail` (618-709) each embed a full ~80-line HTML table template; the verification template uses `escapeHtml` + `resolveVormexLogo()` (inline CID logo) while the reset template does not use the logo helper and interpolates `resetUrl` (URL-encoded token, `frontendUrl` from config) without `escapeHtml`. Same chrome (container table, fonts, colors), different safety handling. Low risk since values are server-built, but the reset email's "name/logo" parity is lost.
- Recommendation: `renderEmailLayout({title, bodyHtml})` + template functions; `sendEmailOrFail(res, ...)`. Risk Low. Confidence High.

##### I7. Admin auth layers
- `requireAdmin` (admin.middleware.ts:6-43) re-queries the DB on every admin request (isAdmin + adminTwoFactorEnabled + session 2FA flag), mounted by `router.use(requireAdmin)` after `authenticate` (admin.routes.ts:121,132) and per-route for hackathons import (hackathons.routes.ts:23). It is the only role check outside services; role/isAdmin is not in the JWT (jwt.util.ts:96).
- Admin controller then re-checks 401 in 39 handlers and re-checks `isAdmin` inside `verifyAdmin` (admin.controller.ts:314-321) and the 2FA handlers `setup2FA`/`verify2FA`/`validate2FA` (359, 436, 490 via `getAdminTwoFactorUser`). INTENTIONAL: 2FA endpoints are mounted before `requireAdmin` (admin.routes.ts:123-130) because `requireAdmin` itself demands a 2FA-verified session, so they must self-check; redundant 401 checks in the other 36+ handlers are dead code.
- Recommendation: delete dead 401 guards in admin handlers only; keep 2FA self-checks. Risk Low. Confidence High.

### Slice B - Content

##### B-I1 Auth + validation + error boilerplate in every handler
- `if (!req.user?.userId) return 401` : post 15, reels 24, stories 12, saved 6, mentions 7, upload 9 (73 in slice; 29 controllers each re-declare `interface AuthRequest`). `ensureString(req.params.x)` + 400 "X ID is required": ~60 times. `catch -> console.error + 500 JSON`: post 17, reels 34, stories 12, saved 6, mentions 8, upload 9 (86). Only post/reels/stories partially route through `safetyErrorResponse` (post createPost/createComment/toggleCommentLike, reels shareReelInChat, stories react/reply); reels createComment/createReel/trackView do not (so `SafetyActionError` thrown by those would be 500).
- Error message wording differs ("Post ID is required", "Post ID and content are required", "Reel ID is required"; 401 identical).
- Type: INFRASTRUCTURE. Consolidation: `asyncHandler` + `requireUser` middleware + typed route params. Risk: Low. Confidence: High.

##### B-I2 Realtime emission: three mechanisms
- Post: transactional outbox `enqueueRealtimeFanout` + `emitRealtimeEnvelopes` after commit (10 sites in post.controller.ts) with room helper `getPostRealtimeRooms` (:306).
- Reels: direct `getIO()` + `io.to('reel:<id>').emit('reel:engagement_update', {type:'like|comment|share'})` (6 sites) - single event name with `type`, vs post's per-event names (`post:liked`, `comment:created`, `post:shared`).
- Stories: direct `getIO()` + `io.emit('story:deleted', ...)` global broadcast (stories.controller.ts:503 emits to ALL sockets with the author id, no block/visibility filtering) vs creation path which filters blocked + visibility (:359-390). Story created for PUBLIC iterates `io.fetchSockets()` (all sockets cluster-wide) per story creation.
- Type: INFRASTRUCTURE. Risk: Med (reel/story events lost on multi-instance or crash; story deletion leaks author id + story id to all online users). Confidence: High.

##### B-I3 Cache invalidation helpers
- post.controller.ts:195-203 `feedCacheTags`/`feedSnapshotCacheTags`; reels.controller.ts:286-302 `invalidateReelsFeedCache`/`invalidateReelCacheTags`; stories.controller.ts:51-53 `invalidateStoryFeedCaches`; saved.controller.ts:13-19 local `invalidateHomeFeedCache`; `updatePost` (:1822) calls `cacheService.invalidateTags` directly while other post paths use `enqueueCacheInvalidation` outbox. Tag vocab: `feed:<uid>`, `user:<uid>`, `feed:global`, `reels:feed`, `stories:feed:global`, `stories:<uid>`, `reel:<id>`. `invalidateReelsFeedCache()` is called on every `updateReel` regardless of status (fine) but `invalidateReelCacheTags` (adds `feed:global`) only from the webhook, so a reel publish via `createReel` invalidates `reels:feed` only.
- Snapshot windows: post `homeFeedSnapshotWindow` (60s window, 5min TTL, env), story `storyFeedSnapshotWindow` (24h window, 48h TTL), reels anonymous feed SWR (10s/45s). Same "snapshot-window cache key" idea implemented 3 times with different constants; story feed with 24h snapshot window + invalidation on view is effectively per-user per-day cache.
- Type: INFRASTRUCTURE. Risk: Low. Confidence: High.

##### B-I4 Logging
- post.controller 26 `console.error` + 2 structured `logger.*`; reels 42 `console.error` + 0 logger; stories 6/0. `console.warn` for expected failures. No request id/user id in any of these.
- Type: INFRASTRUCTURE. Consolidation: use `logger` (already imported in post.controller.ts). Risk: Low. Confidence: High.

##### B-I5 Env/URL config duplication
- Web base URL derived 6 ways: post.controller.ts:2945 (`FRONTEND_URL||'https://vormex.com'`), groups.controller.ts:25, referrals.controller.ts:130, indexnow.service.ts:1, public-content-discovery.service.ts:11 (`PUBLIC_WEB_BASE_URL||FRONTEND_URL||www.vormex.in` plus a `.replace('https://vormex.in','https://www.vormex.in')` normalizer), public-discovery.service.ts:69, recommendation-embedding.service.ts:7. Different default hosts (`vormex.com`, `vormex.in`, `www.vormex.in`) and env var precedence.
- Bunny CDN base: bunny.config.ts:10 default `https://vormex.b-cdn.net`; hard-coded again in mcp/public-discovery.mcp.ts:249,262 and admin.controller.ts:184 (reads config).
- Type: INFRASTRUCTURE. Consolidation: `config/urls.ts#webBaseUrl()`. Risk: Low. Confidence: High.

##### B-I6 Upload validation layers
- Route multer limits + `upload-security.middleware` rules (post.routes.ts:60-70) + controller `files.filter(mimetype.startsWith('image/'|'video/'))` (post.controller.ts:1443-1445, trusts client mimetype) + `validateImage` size check + direct-upload util (disabled) + Bunny. Post `createPost` takes only `startsWith('image/')`/`'video/'` mimetypes after the route-level security middleware, while `maxBytesForDirectUpload` has a strict allowlist (`jpeg/png/gif/webp`, `mp4/webm/quicktime`) that the multipart path does not re-apply; stories `createStory` has only `startsWith`; reels `createReel` thumbnail `startsWith('image/')`.
- Dead direct-upload path: `createStorageUploadIntent` (direct-media-upload.util.ts:134-153) and `validateFinalizedStorageMedia` (:224-236) always throw; yet `getPostUploadUrl` (post.controller.ts:454-490), `finalizePostUpload = createPost` (:1776, `directMedia` branch via `validateDirectPostMedia` :423-452), reels `getUploadUrl` thumbnail branch (:664-680) and `onUploadComplete` thumbnail branch (:933-947) still reference it. `getPostUploadUrl` always responds 500 with the "disabled" message because the error-message check only maps 'large'/'Unsupported' to 400. Dead code kept alive (~150 lines across 4 files).
- Type: INFRASTRUCTURE. Risk: Low. Confidence: High.

##### B-I7 Redundant/dead logic inside feed handler
- post.controller.ts:1049-1056: `candidateLimit` ternary has identical branches for `unifiedRankingEnabled` and `mode==='recommended'`; `cacheCursor = mode==='recommended' ? cursor : cursor` (both arms identical); explicit `authorId notIn blockedUserIds` at :1161/:1190 duplicates the same filter already inside `buildPostVisibilityWhere` (access-control.util.ts:123-126), i.e. `getBlockedUserIds` is queried twice per feed request; post-cache `filteredPosts` re-applies block filter a third time (:1352-1355, intentionally for cache staleness - keep).
- Type: INFRASTRUCTURE. Risk: Low. Confidence: High.

### Slice C - Social & messaging

- IN1. Auth guard + try/catch/500 boilerplate: `if (!req.user?.userId) { res.status(401)... }` appears 99 times across the 12 controllers (groups 24, chat 19, connection 10, people 10, skills 8, identity 7, profile 6, others <=4); `res.status(500)` handlers 110 times (groups 31, chat 12, connection 11, ...). `req.user` typed by 29 local `AuthRequest`/`AuthenticatedRequest` interfaces across controllers. Future: `requireAuth` middleware (already authoritative via route) + `asyncHandler`. Risk Low. Confidence High.
- IN2. Error mapping: `safetyErrorResponse` copy-paste in `connection.controller.ts:229-236`, `follow.controller.ts`, `groups.controller.ts`, `chat` (`sendControllerError` :112 is the only helper, used 15x); `chat.controller.sendMessage` maps three message strings to status codes (:1218-1228) and `index.ts:1815-1822` repeats those strings for sockets. String-matched domain errors; should be typed errors.
- IN3. Logging: slice controllers use `console.error` 120 times (groups 33, chat 15, connection 14, people 13, skills 10, follow 9, profile 8, identity 7, college 6, contacts 4, circles 1); only `talk.controller.ts` uses the structured `getRequestLogger` (:4,:803). Messages differ, no request id.
- IN4. Cache invalidation helpers: chat `invalidateChatCaches` (:156), connection `invalidateDiscoveryCaches` (:56), groups `invalidateGroupListCache` (:122); each wraps `cacheService.invalidateTags` in try/catch with its own message (E2/E3).
- IN5. Cache keys/TTLs for people-like data scattered as magic numbers: people 15/30/60s + 5min (`people.controller.ts:113-125`), talk 30s/2min/5min (:54-56), `chat-conversation-cache` 5min, `readReceiptMemo`/`senderPayloadMemo` 45s, `messageInteractionMemo` 5s, `getBlockedUserIds` 60s, profile core/bundle TTLs. The block-cache stale window therefore is 60s for lists but 0 for pair checks, 5s for message interaction memo (invalidated on block via `invalidateMessageInteractionCache` only from the API process that handled the block; other instances' 5s memo persists).
- IN6. Validation: ad hoc `cleanText`/`ensureString`/`normalizeOptionalString`/`normalizeText` variants per controller (college-communities :21, talk :131, chat none, groups :173). Only `ensureString` is shared (`utils/request.util.ts:5`).
- IN7. `console.log` in socket handlers (`index.ts:2209,2417`) for group join/message; chat-socket uses `logger`. Mixed.

### Slice D - Notifications & infra

##### I-1. Env access scattered (482 `process.env` occurrences; hot files)
- Top non-test: utils/google.util.ts 16, config/auth-security.config.ts 16, agent/realtime-voice.service.ts 16, index.ts 15, services/premium-access.service.ts 12, college-catalog.service.ts 12, hackathon-import.service.ts 9, infrastructure/redis/client.ts 9, utils/email.util.ts 7, workers/index.ts 6, reengagement 6, push-notification 6, config/prisma.ts 7.
- Read at call time vs module load inconsistently: reengagement reads REENGAGEMENT_* per call (tests can override, 6 sites, 40 in its test); push-notification reads per call; workers/outbox/scheduler read at module load (restart required). Boolean parsing: 59 occurrences of `=== 'true'` / `!== 'false'` plus 3 different falsy lists: `['0','false','off','no']` (reengagement:205, match-availability:60 - exact duplicate pair), `['0','false','no','disabled']` (index.ts:248, auth.middleware.ts:27). `HACKATHON_AUTO_IMPORT_ENABLED !== 'false'` accepts only the literal 'false'. `OUTBOX_DISPATCH_ENABLED === 'true'` is read separately in workers/index.ts:52 and scheduler/index.ts:24 (double-gate by design; but two reads of the same flag).
- Consolidation: config/env.ts (typed), Risk Low. Confidence High.

##### I-2. Two parallel Redis client stacks + separate queue factories
- infrastructure/redis/client.ts:92 (`new Redis`, roles critical/cache, 4 critical clients: command, pub, sub, worker + cache) vs infrastructure/proximity/redis-client.ts:15 (single client; URL via PROXIMITY_REDIS_URL with a dev-only REDIS_URL fallback `NODE_ENV !== 'production'`; commandTimeout 750 vs 1000; maxRetriesPerRequest null vs 1; connectTimeout 2000 vs 5000).
- Same boilerplate in both: lazyConnect, enableReadyCheck, retryStrategy, error/ready listeners, connect/close/health helpers (`connectProximityRedis` 50-60, `closeProximityRedis` 62-65 vs `connectRedisClients`, `disconnectRedisClients` in client.ts:232-283). Proximity omits `connect`/`end` logging and the "unavailable reason" map (keeps one `lastError`).
- Queue factories: infrastructure/queue/queues.ts:29-46 and infrastructure/proximity/queues.ts:10-19 (`getQueue` vs `getProximityQueue`, both `Map<string, Queue>` singleton + `close*` function, differing defaultJobOptions and failure type: QueueUnavailableError vs bare Error('PROXIMITY_REDIS_UNAVAILABLE')). Worker factories: workers/index.ts:329-338 `createWorker` vs 4 inline `new Worker(...)` in workers/proximity.ts:100-154 (no shared error/failed/completed listeners; workers/index.ts:378-411 attaches 'completed' backlog gauge + 'failed'/'error' loggers, proximity workers - verify at workers/proximity.ts:100-170 - do not use `shouldLogWorkerError` throttling).
- Count: 2 Redis factories, 2 queue factories, 2 worker setups, 3 retryStrategy/backoff definitions.
- Type: INFRASTRUCTURE; mostly INTENTIONAL isolation (see N-2) but the boilerplate could be a `createRedisClient(options)` factory. Risk Med. Confidence High.

##### I-3. Circuit breaker coverage and misclassification
- Single breaker: utils/http-client-with-breaker.util.ts (state machine 128-189; keyed `provider:operation`; per-process memory state). Used by: bunny_storage (4 sites), bunny_stream (4), college_directory, github (6 ops), hackathon_import (4), resend (2: list_domains + send_email), google_oauth, OpenAI via executeWithCircuitBreaker in ai.service.ts:232, agent/orchestrator.service.ts:436, agent/realtime-voice.service.ts:1043.
- Bypass (raw fetch/axios, no breaker, own timeout): services/recommendation-embedding.service.ts:100-110 (OpenAI embeddings, AbortController 20s, no breaker), services/indexnow.service.ts:9 (fetch + AbortSignal.timeout(5000), console.warn), services/public-discovery.service.ts:81 (OpenAI SDK client, timeout 12s, maxRetries 1), services/google-play-premium.service.ts (google-auth-library, 2 androidpublisher URLs), utils/google.util.ts uses OAuth2Client (SDK) AND fetchWithBreaker for token exchange (165) - two styles in one file. firebase push (firebase-admin SDK) has no breaker.
- Misclassification (real bug risk): `executeWithCircuitBreaker` (catch at 172-188) counts EVERY thrown error as a failure including HTTP 4xx from axios (axios throws on non-2xx). github.service.ts:315-321 treats 404 from `repository_languages` as a normal case (repo deleted/private) and swallows it, but the breaker has already incremented `github:repository_languages` failures; 3 consecutive 404 repos (failureThreshold default 3) open the circuit for 30s so subsequent healthy repos in the same sync fail fast with `third_party_circuit_open`. `getUserRepositories` 404 (user not found) and `getGitHubUserProfile` 401/403 likewise count. Cooldown/half-open logic is fine; the failure predicate is not status-aware.
- Also: `connectTimeoutMs` option is accepted by `executeWithCircuitBreaker` callers (email.util.ts:476-479) but only `requestWithBreaker` uses it (min(connect, request) as axios `timeout`); for the Resend SDK path it is silently ignored. Resend `send()` returns `{error}` instead of throwing, so API-level failures (429/5xx) never trip the breaker; only network throws do.
- SDK retries multiply with breaker: OpenAI clients configured `maxRetries: 2` (ai.service.ts:143-147, orchestrator.service.ts:158-164, realtime-voice.service.ts:419-424) inside `executeWithCircuitBreaker` with its own requestTimeoutMs; a single logical call can retry 3 times inside one breaker "attempt", and the withTimeout race may abort while SDK retries continue. Four OpenAI client constructions with 3 different timeouts (AI_TIMEOUT_MS 20s; AGENT_AI_TIMEOUT_MS||AI_TIMEOUT_MS 45s; 12s; 20s raw) and key lookup `OPENAI_API_KEY || AI_API_KEY` duplicated 3x (recommendation-embedding uses only OPENAI_API_KEY).
- Consolidation: add `isFailure(error)` option (ignore 4xx except 408/429), single OpenAI client factory. Risk Med. Confidence High for the 404 behavior (code read directly).

##### I-4. GitHub error mapping repeated 5x with divergent 403 handling
- github.service.ts error blocks: checkRateLimit 104-112, exchangeCodeForToken 145-155, getGitHubUserProfile 194-208, getUserRepositories 269-281, getRepositoryLanguages 315-330 (each `axios.isAxiosError` + status switch).
- 403 differences: profile -> throws "Access forbidden. Token may not have required permissions." when remaining != '0'; repos/languages -> rethrow raw AxiosError when remaining != '0'; token exchange/rate-limit have none. 404: repos throws friendly error, languages returns `{}`+warn, profile has none. Rate-limit header read `x-ratelimit-remaining === '0'` repeated 3x.
- Also each call repeats `{ connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 }` (5x; contribution calendar uses 12_000) and the same two headers (`Authorization Bearer`, `Accept application/vnd.github+json`) 5x. Consolidation: `githubRequest(op, config)` wrapper mapping statuses once. Risk Low. Confidence High.

##### I-5. Logging: pino vs console mixed inside the same files
- `lib/logger.ts` pino exists, but within slice: notification.service 2 console / 0 logger, reengagement 1/0, match-availability 2/0, email.util 2/0 (logs recipient email on success, 607 and 708), github.service 12 console (incl. `console.log` on every rate-limit check, 98), hackathon-import 5/0, google.util 1/0. push-notification.service mixes both (5 console / 10 logger) - the same send flow logs `console.log('Push notification sent...')` 248 but `logger.error` for disabled/ messaging-unavailable (171-197). workers/outbox/redis/firebase use pino exclusively with `event:` keys.
- Repo-wide console.* leaders: index.ts 56, reels.controller 45, admin.controller 44, groups.controller 33. 
- Consolidation: replace console with pino child loggers; Risk Low; Confidence High. (Also PII: email addresses and user ids printed via console.)

##### I-6. Cache wrappers
- services/cache.service.ts is a 1:1 pass-through facade over redisCacheService (get/set/getOrSet/del/delPattern/invalidateTags/exists/incrementFixedWindow/getStats) - 31 files import cacheService, 3 import redisCacheService directly. The facade adds only a default TTL of 300 (same default as redis-cache `ttlSeconds ?? 300`) and `applicationCacheEnabled:true`. EXACT-ish duplication with no behavior of its own.
- Ad-hoc in-process TTL maps outside the shared cache: TtlMemo (infrastructure/cache/ttl-memo.ts, used by chat-message.service, chat-conversation-cache.service, trust-safety.service, index.ts) vs hand-rolled Map+expiresAt in controllers/identity.controller.ts (4 hits), recommendation-platform.service.ts, feed-viewer-context.service.ts, arcade.service.ts, stories.controller.ts, utils/email.util.ts:12,183-200 (EMAIL_SERVICE_CHECK_TTL 5min), utils/state.util.ts, direct-media-upload.util.ts, proximity-session.service.ts, auth-session.service.ts. Roughly 10-14 independent TTL caches (grep `expiresAt`/`_TTL_MS`); stampede protection exists only in redis-cache getOrSet (in-flight map + lock + 50ms poll loop at 430) and TtlMemo (in-flight promise).
- Raw `redisCommand` usage outside the cache layer: index.ts (chat presence Lua x3, typing rate), arcade.service.ts:201, auth-session.service.ts:117,315, auth-gate, auth-user-status-cache, rate-limit.service, recommendation-platform.service (14 files list). Key prefixes differ: cache layer `vormex:`; presence `vormex:chat:presence:`; rate limiter `rate:`; heartbeat `vormex:health:background:` - prefix is a convention, not enforced.
- Consolidation: remove facade or make it the only import; Risk Low. Confidence High.

##### I-7. Scheduling: two systems for periodic work
- BullMQ job schedulers: scheduler/index.ts registers 3 interval jobs (scheduled_publish, people_you_know, outbox_dispatch) + 18 cron patterns from cron.service.ts `maintenanceSchedules` (UTC patterns, comments absent; IST-slot logic lives in reengagement only: hourly cron at minute 30 `30 * * * *`, slot hours interpreted as IST by `getCurrentReengagementWindow`). The 3 interval jobs and the 18 cron jobs use different registration loops (scheduler/index.ts:39-90) and the maintenance queue handles `outbox_dispatch_tick` and chat reconciliation special-cases before delegating to `runMaintenanceJob` (workers/index.ts:292-327).
- Request-path lazy scheduling: hackathon-import.service.ts:775-810 `ensureExternalHackathonsAvailable` kicks `importExternalHackathons` from API requests with an in-process 15min throttle (`lastAutoImportAttemptAt`) while cron `hackathon_external_import` (`15 */6 * * *`) does the same import. Two triggers, per-process throttle (N instances = N imports per 15 min), both notify matched users on `created`.
- Multi-instance concern: scheduler registration is idempotent via `upsertJobScheduler`; the in-process setInterval at index.ts:331 (presence refresh) is per-socket and correct.
- Type: INFRASTRUCTURE/FUNCTIONAL. Consolidation: drop request-path import or guard with a Redis lock. Risk Med. Confidence Med.

##### I-8. Date/time helpers
- Only one IST implementation in the whole codebase: reengagement-notification.service.ts:4,208-236 (`IST_OFFSET_MS`, `shiftToIst`, `formatDateKey`, `getIstStartOfDayUtc`, `addDays`). Repo-wide "start of day" idioms (`setHours(0,0,0,0)`, UTC date keys) appear in recommendation-learning.service.ts (28 hits of date idioms), ai-chat.controller (21), discovery-power (10), progress.service, activity.service, engagement.service, groups.controller, games.controller etc. These compute "today" in SERVER-LOCAL time or UTC while reengagement computes the "day" in IST. For streaks/engagement (engagement.service resetWeeklyCounters at cron `30 18 * * 0` = Sunday 00:00 IST, streak_freeze `0 19 * * *` = 00:30 IST) the cron times are IST-aligned in UTC, but in-request helpers use server time; if the server runs in UTC, "growth today" (IST) for reengagement and "streak today" (UTC) for engagement.service disagree for the 5.5h window 18:30-24:00 UTC: reengagement may say "you grew today" for activity the streak system has already counted into the next/previous day. Confidence Low-Med (engagement.service not in slice; only pattern grep).
- Fix: `utils/time.util.ts` with `istDayStart`, `dayKey(tz)`. Risk Med. Confidence Med.

### Slice E - Premium & admin

**I1. Auth guard + try/catch/500 boilerplate** - `if (!req.user?.userId) { res.status(401)... }` appears in 164 handlers across the 18 controllers (admin 39, professional-fields 23, engagement 18, games 13, premium 9, admin-premium 8, skills 8, hackathons 7, reports 6, jobs 6, learning 6, store 5, interviews 4, others <=3). Variants: `String(req.user.userId)` vs raw; some handlers re-check inside admin-only routes already behind `requireAdmin`. 29 controllers repo-wide redeclare `interface AuthRequest extends Request {user?:{userId:string}}` (premium.controller.ts:45, referrals, badges, store, challenges, premium-post-boost.controller.ts:10, ...), while others use `AuthenticatedRequest`. Recommendation: shared typed request + `asyncHandler` + route-level `requireAuth`. Risk Low. Confidence High.

**I2. Error response shapes inconsistent** - `{error}` (most), `{success:false,error,code,feature,title}` for premium gates (premium-feature-gates.service.ts:60-70, 402), `{error,code,retryable}` (reports via `safetyErrorResponse`), raw internal messages (premium-post-boost.controller.ts:11-22), `{error, message}` 200-status "errors" (games.controller.ts:480-485 returns 200 with `error`). Premium-required status 402 (gates) vs 403 (`activateProfileBoostForUser`, premium-visibility.service.ts:339-345; people.controller). Risk Med for clients.

**I3. Pagination parsing differs** - uncapped `limit`: admin.controller.ts:869-870 (users), 1191-1192 (posts), 1274-1275 (reels), 1373-1374 (groups), engagement.controller.ts:1515 (`getStreakHistory`); capped: admin :1535 (50), :2104 & :2614 (100), hackathons.controller.ts:275-276 (50), reports.controller.ts:585-586 (50), games.controller.ts:151,198 (50/100). Unsafe: games.controller.ts:676, 713 `Math.min(50, Number(limit))` (NaN or negative `take`), :1280. Page `|| 1` accepts negative page for some (skip negative -> Prisma error). Recommendation: `parsePagination(req, {defaultLimit,max})`. Risk Low-Med.

**I4. Validation by hand** - professional-fields.controller.ts repeats `typeof x !== 'string' || x.trim().length < 2 || x.length > 100` ~24 times (create + update for 6 entities, e.g. :322, :327, :422, :430, :607-617, :711-727, :898, :1005, :1262-1267, :1344-1352, :1515-1527, :1603-1621) and 2000-char description rules x8; checks untrimmed length for max but trimmed for min. `validateUrl`/`validateDateRange` local (:39-56). No schema validation (zod/joi) in slice. Risk Low. Confidence High. Also cache invalidation: `invalidateProfessionalProfileCaches(userId, true)` (search reindex) only for skills/interests (:132, :238, :1880...), not for experience/education/projects/certificates although those likely feed the search document (Low confidence; check `reindexPublicProfile`).

**I5. Logging** - emoji `console.log` in engagement.service.ts (success/error each cron), per-request `console.log` in activity.service.ts:121-124, 240-243 and engagement.controller.ts:1923; `console.error` everywhere, no structured logger in slice. Risk Low.

**I6. Razorpay/Google clients** - Razorpay via `requestWithBreaker` with timeouts (premium-razorpay.service.ts:20-21, 57-100) good; Google Play via `googleapis` client (google-play-premium.service.ts:161-205) with its own error class (`GooglePlayPremiumVerificationError`) while Razorpay uses `{ok:false,statusCode,error}` unions (`RazorpayActivationResult`) and `getSafeRazorpayError` in the controller (premium.controller.ts:71-130). Two error-handling conventions for one flow. Risk Low.

### Slice F - API, agent, discovery

**I1. Response / error envelope inconsistent**
- Controllers: 1479 `json({ error: '...' })`, 57 with `code:`, 34 `success:false` (all social-proof.controller.ts), 41 `{ message: ... }`.
- Global `errorHandler`/`notFoundHandler` (middleware/errorHandler.ts:30-47) return `{ status, message, requestId }` (no `error` key), unlike controller errors. 429s: `{error, code, requestId, retryAfterSeconds}` (rate-limit.middleware.ts:207) vs proximity `{error:{code,message,retryable,retryAfterSeconds}}` (:200) vs AI limiter `{error, code:'ai_rate_limited', ...}`; validation `{error:'Invalid request input', message}` (input-validation.middleware.ts:9) vs injection `{error, code, field}`.
- Success shapes: post `toggleLike` returns both `liked` and `isLiked` (post.controller.ts ~2236); reel returns `{liked, likesCount}` only.
- Recommend: `sendError(res,status,code,message)` helper, keep legacy `error` key. Med (mobile clients parse). High.

**I2. Auth guard boilerplate**: 418 `req.user?.userId` checks and 353 literal `res.status(401).json({ error: 'Unauthorized' })` in controllers even though 54 of 57 route files apply `authenticate` (only oauth/password/verification have none, expected). Redundant but harmless; needed behind `optionalAuth`. Low.

**I3. Middleware chain inconsistencies (routes)**
- Route-level rate limiters exist in only 18 of 57 files (admin, agent, ai-chat, auth, chat, groups, identity, oauth, password, post, premium, proximity, recommendation, reels, stories, talk, upload, verification; chat/groups/post/reels/stories/upload only on media routes). Everything else relies on global `generalApiRateLimit` (index.ts:2899): comments, likes, follow, connection requests (connection.routes.ts:18), reports (reports.routes.ts:20-24), saved, events, hackathons, jobs, etc. Reports trigger moderation queues but have no dedicated limiter; connection requests rely on the controller trust-tier + daily limit.
- Payment limiter coverage: premium.routes.ts:36-41 applies `paymentActionRateLimit` to checkout/verify/post-boosts/cancel but NOT `POST /boosts/profile` (:33 `activateMyProfileBoost`) or `PATCH /creator-pro/settings` (:31).
- Expensive public search: `/api/public/discovery/*` (routes/public-discovery.routes.ts) has no route limiter beyond global; MCP has `mcp:search:ip` 60/min (mcp/public-discovery.mcp.ts:32). Both reach the same `searchPublicPeople` (may call OpenAI embeddings).
- `validateMultipartFields`: present on post create, chat upload, reels create, stories create, `upload/group-icon|cover`; absent on `groups/:groupId/upload/icon|cover` (groups.routes.ts:86-87) and `/upload/avatar|banner|certificate|project|logo`. The same controller (group icon) gets different field sanitization by path.
- `authenticate` style: `router.use(authenticate)` (most) vs per-route (people, matching, profile, upload, reels, groups, hackathons). Intentional for mixed public/private files, but upload.routes.ts and reels.routes.ts add it per route though every route is private.

**I4. Logging**: `console.log` vs structured `logger` mixed in index.ts socket handlers (e.g. :1551 console.log vs :1783 logger.info). Low.

**I5. Hand-maintained API contracts**: `openapi.yaml` (3148 lines) documents 67 paths vs ~594 route registrations (no `/ai/chat`, `/agent`, `/talk`, `/public/discovery`). Public discovery has a second contract inline in controllers/public-discovery.controller.ts:128+ (`publicDiscoveryOpenApi`) and a third in zod (mcp/public-discovery.mcp.ts:50-198: `publicPersonSchema`, `publicProfileSchema`, `publicPostSchema`, `publicOpportunitySchema`). Person-card fields are declared by hand in 2-3 places. Recommend generating JSON schema from zod. Low-Med.

**I6. AIServiceError -> HTTP mapping and provider error mapping duplicated**: ai-chat.controller.ts:111-150 `sendAIError`, agent.controller.ts:66-89 `sendAgentAIError` (same body minus the 500 branch), talk.controller inline; provider mapping in orchestrator.service.ts:285-450 (165 lines, OpenAI + Gemini branches) and realtime-voice.service.ts:290-346. The quota check `code==='insufficient_quota'||type===...||/quota/i` is written 4 times (orchestrator:301, realtime:297, :312, :328). Recommend `ai-errors.ts`. Low / High.

**I7. Env helpers**: `intEnv` (orchestrator.service.ts:94), `trimmedEnv` (:153), inline `Number(process.env.X || n)` in ai.service, realtime-voice, ai-chat. Unify via config. Low.

## Intentional Duplication

### Slice A - Cross-cutting

1. Proximity API v1 error/limit shapes (`{ error: { code, message, retryable } }`) in auth.middleware.ts:185-190, rate-limit.middleware.ts:208-215, and strict limit validation proximity.controller.ts:168-192. Separate versioned contract; do not merge with the legacy `{error}` envelope.
2. `authenticate` vs `optionalAuth` vs `verifySocketAccessToken` (auth.middleware.ts:178, 309, 71): share `resolveRequestAuth`/`assertTokenPassesAuthGate`; only differ on purpose (socket tickets accept `purpose:'socket'`, normal tokens reject any purpose). Good design, not duplication.
3. Admin 2FA handlers living before `requireAdmin` (see I7).
4. Password-reset token flow (password.controller.ts) vs email OTP flows (F3): token-in-link vs 6-digit code, different storage and lifetime; only the email-service pre-check is shared.
5. `canViewX` single-row checks vs `buildXVisibilityWhere` list builders (B1): two forms are necessary for performance (SQL filtering vs per-row), only the rule parity (isActive/expiry/caching) needs attention, not merging.
6. Engagement leaderboard queries re-deriving connections (engagement.controller.ts:412, 535, 655): aggregate/batched versions of connection checks; keep.
7. Trust-tier limits (`enforceTrustTierLimit`, rolling windows by trust level) vs premium tier limits (tier-limits.service.ts, daily free caps): conceptually different controls (abuse vs monetization). The overlap is only in how they are combined at call sites (B8).
8. Cached `getBlockedUserIds` (list filtering) vs uncached `findBlockBetween` (point check, must be immediate for messages): staleness difference is deliberate; `messageInteractionMemo` adds a 5 s memo for chat sends (trust-safety.service.ts:~40).
9. Group chat message-delete socket handler (index.ts:2433) living in the socket layer: different transport; only the role predicate should be shared (B4).

### Slice B - Content

##### B-N1 `public-content-discovery.service.ts` post queries vs `buildPostVisibilityWhere`
Both express "which posts are visible", but public discovery serves anonymous/AI-crawler contexts: only `visibility='public'`, `type='text'`, non-empty content, authors with `aiDiscoveryEnabled`, not banned, not restricted/suspended; no viewer, no block list, no collaborators. Authenticated visibility (`buildPostVisibilityWhere`) is a strict superset in a different dimension (viewer-relative). Keep separate; share only the `publicAuthorEligibility()` idea if feed ever needs author safety state. Its scoring (`lexical*10 + recency*3 + engagement*2`, engagement `likes + 2*comments + 3*shares`) is deliberately different from the home-feed engagement weighting (1/3/5). Do not consolidate.

##### B-N2 Reel scoring `reelForYouScore` / `rankForYouReels` vs post feed rankers
reels.controller.ts:725-752 is an in-page re-sort of the chronological reels page; different entity, signals (watch time, completion), no relationship graph. Not the same rule as the post feed. Keep separate (but see B-R1: it ranks a block-unfiltered page).

##### B-N3 `getPublicPost`/`listPublicProfilePosts` `cursor:{id}` raw id cursors
Public, anonymous, low-stakes; signed cursors unnecessary. Keep, but note B-D5 stale-cursor risk (deleted row => throws).

##### B-N4 Story DM payload (`fileName` JSON blob) vs reel DM payload (`content` JSON)
Different content types (`story_reply`/`story_reaction` vs `reel`) with client renderers keyed on them; the shape difference is a wire-contract artifact, not accidental duplication. Consolidate the plumbing (B-E5), not the payload shape.

##### B-N5 Cursor signing vs upload-token signing vs Bunny webhook signing
Same primitive, three trust domains (client-held cursor, client-held upload credential, third-party webhook). Keep distinct payload schemas and ideally distinct secret env vars; only the HMAC/base64url mechanics (B-F8) are shareable. The JWT_SECRET fallback chain in both utils weakens domain separation, so a shared helper must keep `scope`/`purpose` in payload.

##### B-N6 Post-level `likesCount` recount vs reel atomic increments
The post path recounts inside the tx because it also switches reaction types (a plain +/-1 cannot express switch), so that difference is justified; what is NOT justified is the missing P2002 handling and 5-type reactions not existing on reels (product decision). Do not blindly copy the reel counter strategy to posts.

##### B-N7 Boost placement vs organic eligibility
`selectPostBoostPlacements` uses its own `public`-only, active-window, daily-frequency-cap (3/day) and owner-not-viewer rules and a semantic+graph targeting score (0.65/0.35). That is a paid-surface policy, not organic ranking. Keep separate from `feed/*`; just fix B-E1 and ensure the same eligibility gate (`isBanned`, blocks) is applied.

##### B-N8 `keyset-pagination.util` helper variants
`dateDescKeysetWhere`, `dateAscKeysetWhere`, `nullableDateDescIdAscWhere`, `numberDescDateDescIdDescWhere` differ in sort direction/nullability; look similar but encode different orderings. `createdAtDescKeysetWhere` is a pure alias (`dateDescKeysetWhere(cursor,'createdAt')`) - harmless. Keep.

### Slice C - Social & messaging

- I1. `proximity-*.service.ts` eligibility/summary/session logic separate from people discovery: different data source (Redis geo + `proximity_preference`), stricter (restricted/suspended) rules, and displacement privacy (`proximity-privacy.service.ts:displaceMarker`). Keep separate, but share the user-eligibility fragment (BR-11) and block set.
- I2. `findBlockBetween` (pair) vs `getBlockedUserIds` (set): hot-path single check vs bulk list with cache. Keep both; add one shared test matrix (explicit block both directions, device-scope both directions).
- I3. `proximityRedis` client vs `infrastructure/redis/client.ts`: separate env (`PROXIMITY_REDIS_URL`), separate circuit-breaker semantic (`maxRetriesPerRequest:null`, 750ms commandTimeout, 3 attempts) and failure isolation from critical/cache Redis. A shared factory function is fine, merged instances are not.
- I4. `realtime/channels.ts` (emitted-marker `SET NX` claim, 120s) and `realtime/emitter.ts` (per-process `recentlyEmitted` Map, 120s, 10k cap): two layers of exactly-once dedupe (cross-instance vs in-process). Same TTL constant duplicated intentionally per layer; could share the number.
- I5. `groups.controller` role rank math in `updateMemberRole` (:2300-2315) and `removeMember` (:2372-2380) vs `hasGroupRoleAtLeast`: needs "actor outranks target" (strict) in addition to "actor >= minimum". Different rules (role change needs admin; removal needs moderator). Keep, but extract `canActOn(actorRank, targetRank, minRole)`.
- I6. `chat.getMessageRequests` (:1927) and `getMessageRequestsCount` (:2046) vs `getConversations` (:358): same base visibility filter but request list must post-filter non-connected peers; list/count variants intentionally differ (count is cheap path). Only the base `where` should be shared (DA4).
- I7. `people.controller.getPeople` vs `searchPeople` vs `getSuggestions`: different pagination (keyset cursor vs offset), ranking (premium visibility reorder inside DB page, rank SQL), quota rules. Do not merge the handlers; share card mapper, relationship summary, blocked clause.
- I8. `identity.controller` email-domain validation vs `college-communities.isTrustedCollegeVerification` (:70): trust gate vs mapping; separate concerns. Only `normalizedCollegeKey` should be shared (BR-17).
- I9. `profile-view-analytics.service.enqueueProfileViewAnalytics` (queue, dedupe by job id) vs `social-proof.service.trackProfileView` (:109-175, inline DB write, 5-min duplicate window, notification): two generations of the same feature. Not purely intentional: both check `areUsersBlocked`; consolidation should keep the queue path and move the notification to the worker. Medium risk, flagged here because the two have different dedupe windows (job-id by time bucket vs 5 min query).

### Slice D - Notifications & infra

##### N-1. `pushNotificationService` mode resolution vs `firebase-admin.service` credentials
- push-notification.service.ts:56-143 (`hasFirebaseCredentials`, `resolvePushNotificationMode`) and firebase-admin.service.ts:9-25 (`firebaseCredentials`) both read FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY. Not purely duplicate: push decides mode (firebase/mock/disabled, fatal in production) while firebase-admin builds the credential object (with `\\n` replace, which push's presence check skips). Keep separate but the env read could share one helper. Do not merge modes into firebase-admin (it also serves Auth and AppCheck, which have no mock mode).

##### N-2. Separate Redis (proximity vs critical/cache) and separate queue families
- Different failover policy by design: proximity uses commandTimeout 750ms and a circuit breaker for API waits, `maxRetriesPerRequest:null` for BullMQ, no production fallback to REDIS_URL (redis-client.ts:4). Isolation prevents a hot geo workload from starving sessions/queues. Share the boilerplate factory (I-2), not the instances.

##### N-3. `reengagement` and `match-availability` both `normalizeText`/enabled-flag helpers and "best match" selection
- reengagement-notification.service.ts:687-789 (`findBestMatchCandidate`: simple goal/college/active scoring, pool 12) vs match-availability + matching-engine.service.ts (`scoreUserMatch`, `isStrongMatch`, skills/interests/goals, visibility). Two different match qualities for different campaigns (nudge copy vs "strong match" alert). Scoring weights differ (40/25/10 vs engine). Keep separate unless product wants the nudge to reuse the engine; then it becomes BUSINESS-RULE drift (nudge may recommend a weak candidate the digest would reject, and ignores premium visibility `getPremiumVisibilityByUserIds`, so it can name a user who hid themselves from matching). Flag as a risk to confirm, not a mechanical merge.

##### N-4. Realtime outbox policy vs queue max ages
- outbox/dispatch-policy.ts (age-based expire/quarantine) and chat stale push (workers/index.ts:67-77, 24h) look similar to NOTIFICATION_MAX_AGE_MS (24h, dispatch-policy.ts:26) but operate at different layers: outbox expiry runs before enqueue, stale-chat check runs at delivery after queue wait/retries. Both needed; they happen to share a 24h default. Consider referencing one constant. Also `incrementFixedWindow` (cache) vs sliding limiter (B-6) are a deliberate cost trade-off for AI quotas if product accepts boundary bursts.

### Slice E - Premium & admin

- **Razorpay signature functions**: `verifyRazorpaySignature` (HMAC of `order|payment`, checkout) vs `verifyRazorpayWebhookSignature` (HMAC of raw body) are different algorithms; the thin re-export wrapper in premium-razorpay.service.ts:105-111 (adds default secret) is not duplication. Keep.
- **Daily Activity Streak vs category streaks**: product-level difference (login does not preserve the daily streak, progress.service.ts:34-38). Keep two concepts, but share date math and storage (B7).
- **Premium visibility priority (premium-visibility.service.ts) vs managed-ad `premiumStates` (managed-ad.service.ts:395-425)**: ranking vs ad targeting; both rely on the canonical predicate (good). Do not merge.
- **Lean connection-limit read vs full snapshot** (tier-limits.service.ts:26-40 vs 72-76): deliberate hot-path optimisation (comment at :27-28); fix by sharing select (D1) not by merging.
- **Four leaderboards** (games, arcade, challenges, engagement): different metrics; keep separate but rename/derive consistently (B9).
- **premium-post-boost raw SQL / FOR UPDATE** vs Prisma elsewhere: raw SQL needed for credit-window upsert + locks; keep. Hackathon status helper vs query `where` (F6): need both forms.
- **Trust-tier rate limit vs tier quota on connection requests** (B6): conceptually distinct (abuse control vs monetisation); keep both but share error contract.
- **Admin DM skipping block checks** (F5): reasonable for support outreach; document and make explicit.

### Slice F - API, agent, discovery

1. **`getLeaderboard` x4** (challenges, engagement, games, social-proof), `getMyStats` x2, `getCategories` x4, `getUnreadCount`/`markAsRead` (chat vs notifications): same names, different domains/data. Do not merge.
2. **Public discovery REST vs MCP**: both thin adapters over `public-discovery.service`/`public-content-discovery.service` (REST adds Cache-Control; MCP adds structuredContent/display metadata). Keep adapters; consolidate only schemas (I5) and the redundant clamp (E8).
3. **assistantChat vs careerChat vs agent vs talk**: four product contracts (stateless helper, career persona, tool-using premium agent, people-aware talk) with deliberately different system prompts (ai-chat.controller.ts:1003-1021 vs 1085-1095). The agent uses Gemini for text turns and OpenAI only for STT/TTS (orchestrator.service.ts:891, 1231-1270); realtime voice uses the OpenAI Realtime API. Only client setup (F6), error mapping (I6) and quota (BR11) are real overlaps.
4. **`/api/proximity/v1/*`**: own error envelope, limiter set and 16KB body guard (proximity.routes.ts:11-35, rate-limit.middleware.ts:199): intentional versioned contract; do not unify error shape.
5. **recommendation-engine / -learning / -embedding / -platform / -model-serving**: layered responsibilities (pure ranking math / offline training / vector refresh / session+event ingestion / model loading). Overlap limited to E6, BR8. `surface-recommendation` decorates lists of reels/stories/people/jobs/events; `home-recommendation` ranks posts (F8 is the real duplication).
6. **Hackathons vs events routes**: parallel CRUD shape, different aggregates (teams/applications vs RSVP). Do not merge.
7. **`/api/follow` vs `/api/connections`**: different relationship models; both expose `status/:userId`.
8. **`chat:send_message` path**: correctly shares `sendChatMessage` with REST; the pattern other handlers should follow (only difference: activity recording, BR9).
9. **Admin + paid routes with their own limiters** (admin.routes.ts, premium.routes.ts, auth/oauth/password/verification): bespoke, security-driven; keep local (but see I3 for the two missing premium routes).

## Large File Responsibility Analysis

### `src/index.ts` - what it is

`index.ts` (3113 lines, `// @ts-nocheck`) is the REAL server entrypoint, not a duplicate. `api.ts` is one line, `import './index';` (alias entry, no duplication). There is no separate app-setup file. index.ts contains (approx. ranges):
- 1-290: imports, env validation, trust-proxy/CORS/redis bootstrap
- 289-690: socket helpers: shared chat presence (Redis), typing/group rate limits, realtime rooms, presence emit
- 686-1235: SIX transactional "WithFanout" domain writers (post react, post comment, comment like, poll vote, reel like, reel comment), used only by socket handlers
- 1235-2705: `io.use` auth + `io.on('connection')` with 39 `socket.on` handlers (agent voice, post/feed, chat, group, reel, story, location)
- 2705-2970: express middleware chain, health, metrics, swagger, 57 router mounts, MCP
- 2972-3113: startup/shutdown
Route registration is NOT duplicated (each router mounted once). The duplication is that ~1500 lines of socket handlers re-implement REST controller business logic (Business rule section).

---

### Slice A - Cross-cutting

##### controllers/admin.controller.ts (2982 lines, 56 handlers)
- Responsibilities: admin identity + 2FA (299-520); dashboard stats (519); notification audience/send/re-engagement (601-860); user CRUD + ban/unban/verify/delete (862-1183); posts/reels/groups listing + deletion (1184-1526); group member admin + chat clearing (1527-2100); identity review queue (2101-2333); safety actions warn/restrict/suspend/clear (2334-2478); report queue + `takeReportAction` + mappers (2479-2970); audit-log stub (2972).
- Duplicated inside: 401 guard x39, catch/console.error x44-45, `parseInt(...)||20` pagination x7 (5 unbounded), duplicate "reason required" validation x4, `mapAdminUser`/`mapAdminGroup`/`mapUserToReportUser` mappers, `parseSafetyDuration(req.body?.until || req.body?.days, 7d)` x3, user-update + `recordSafetyEvent` + `invalidateAuthUserStatus` sequences x6 (ban/unban/restrict/suspend/clear + report action).
- Shared with other files: moderation vs reports.controller.ts (shared tables `moderation_reports`); content deletion vs post/reels controllers (B2); group role/remove vs groups.controller.ts (B4); identity review vs identity.controller.ts + trust-safety.service; notifications vs notification.service.
- Natural extraction: `admin/auth-2fa.controller`, `admin/users.controller`, `admin/content-moderation.controller` (posts/reels/groups delete), `admin/groups-admin.controller`, `admin/identity-review.controller`, `admin/safety-actions.controller`, `admin/reports.controller`, `admin/notifications.controller`; shared `admin/validators.ts` (pagination, reason).

##### controllers/auth.controller.ts (682 lines)
- Responsibilities: current user, username generation/resolution (61-127), register (173), login (357), refresh (541), logout/logoutAll (646/664).
- Duplicates inside: OTP issuance x2 (250, 465); banned/suspended/unverified gating x2 (login 445-495, refresh 576-606); email-service pre-check + failure mapping x3; `{password, emailHash, isBanned, ...safeUser}` strip pattern x2 (518, 608).
- Shared with other files: OTP/email flow with verification.controller.ts and password.controller.ts; account gate with oauth.controller.ts, auth-gate.service.ts.
- Extraction: `auth/registration.service` (username, existing-user merge), `auth/account-gate.ts`, `auth/otp.service`, keep controllers thin.

##### controllers/identity.controller.ts (633 lines)
- Responsibilities: student email domain validation (28-131), identity summary (163), phone verification (182), student-email OTP request/confirm (226/338), ID document upload/submission (427/477), student badge claim (569).
- Duplicates inside: 401 guard x7; inline email regex (238, E4); OTP issue/verify mirrors auth/verification flows (F3) but stores in `identity_verifications.metadata.otpHash`, with its own 60 s cooldown (B6).
- Shared with: services/trust-safety.service.ts (`recomputeIdentityTrustLevel`, `getIdentitySummary`, `recordSafetyEvent`), admin.controller.ts identity review handlers (2101-2333, same tables).
- Extraction: `identity/student-email.service` (domain rules + OTP), `identity/id-document.service`, `identity/phone.service`.

##### controllers/reports.controller.ts (625 lines)
- Responsibilities: reasons catalog (17-40), `createReportWithSafety` (61-135, shared transaction), reportPost/Comment/Chat/User/Group (145-575), my reports (578).
- Duplicates inside: 401 + id-required guards x6; `description.slice(0, 5000)` x5; success body `{success, message, reportId}` literal x5; evidence snapshot builders per type (legitimately different); chat open-report/upgrade-to-block logic (276-436) duplicates block creation tx from `createReportWithSafety` (block + `recordSafetyEvent` + `emitSafetyStateChanged`).
- Shared with: safety.controller.ts and trust-safety.service.ts (block creation), admin.controller.ts (moderation queue/actions consume these rows).
- Extraction: `reports/report-service.ts` (create, dedupe, self-report rule), evidence builders per type, `reports/reasons.ts`.

##### controllers/upload.controller.ts (599 lines)
- Responsibilities: multer config, profile avatar/banner upload+delete (87-372), certificate/project/logo image uploads (373-492), generic delete (493), chat media upload (538-599, size/type/duration rules).
- Duplicates inside: avatar vs banner and delete pairs are near-exact (E6); certificate/project/logo exact modulo strings; 401 guard x11; `req.file` + 10 MB `validateImage` x5.
- Shared with: routes/upload.routes.ts and chat.routes.ts (multer/limits constants, E3), groups.controller.ts (group icon/cover use `validateImage` too, 2 sites), post/reels/stories uploads (separate multer configs: routes/post.routes.ts:34, reels.routes.ts:16, stories.routes.ts:8, plus agent voice, identity evidence, admin managed ads).
- Extraction: `upload/image-upload-factory.ts`, `upload/chat-media.controller.ts`, shared `upload.constants.ts`.

##### utils/email.util.ts (709 lines)
- Responsibilities: Resend client/config, error normalization + public failure mapping (42-410), readiness check with TTL cache + circuit breaker (225-345), logo resolution (419), `sendEmail` (459), two HTML templates (513-709).
- Duplicates inside: two ~80-line HTML layouts (I6); `ensureEmailServiceReady` called by both callers and `sendEmail`.
- Shared with: `http-client-with-breaker.util.ts` (`fetchWithBreaker`/`executeWithCircuitBreaker` used here), controllers' pre-check pattern.
- Extraction: `email/provider.ts` (client, readiness, errors), `email/templates/*.ts`, `email/send.ts`.

### Slice B - Content

##### controllers/post.controller.ts (3021 lines)
- Responsibilities: (1) home-feed orchestration (cache keys/snapshot windows, v2/unified/legacy dispatch, ad placement, debug payload) :99-1394; (2) viewer recommendation-context building :493-666; (3) media validation/upload/cleanup :312-492, :960-1000; (4) post CRUD + collab invites :1396-2078; (5) reactions/poll :2080-2370; (6) comments :2372-2886; (7) share/likes list :2887-3021; (8) realtime room helper + impressions endpoint :284-310.
- Duplicated inside: three comment mapper copies (B-F4), `canViewPost` preamble x9 (B-D2), `findMany` author selects x5 (B-F5), feed cacheCursor/candidateLimit dead branches (B-I7), peer-ids query (B-F3), tx + outbox + cache-invalidation triple repeated in like/comment/share/delete/vote (5x: `enqueueRealtimeFanout`+`enqueueCacheInvalidation(tags: feedCacheTags(feed:author,user:author))`).
- Shared with other files: access-control, post.util mapping, feed/*, feed-algorithm, reels (comment/like/poll semantics), saved (save), reports (post report), notification service.
- Natural extraction boundaries: `post-feed.controller.ts` + `feed-orchestrator.service.ts` (1-1394), `post-comments.controller.ts` (2372-2886), `post-engagement.controller.ts` (like/vote/share/likes), `post-media.service.ts` (312-492, 960-1000), `post-collab.service.ts` (1836-2017), `feed-viewer-profile.service.ts` (493-666; likely deleted with legacy ranker).

##### controllers/reels.controller.ts (3069 lines)
- Responsibilities: DTO mapping + includes :83-270; cache/cursor helpers :271-340; feeds (for-you/following/trending/hashtag/audio/user/liked/saved/drafts) :341-532, :2445-2720; upload (multipart/TUS/Bunny Stream) + create/update/publish/delete :644-1170; engagement (like/save/share/share-in-chat/view batching) :1170-1850; comments :1853-2310; poll/quiz :2312-2444; analytics :2764-2925; report :2926-2990; transcoding webhook :2991-3069; reel audio :574-643.
- Duplicated inside: 9 `findUnique + canViewReel` preambles (B-D2), two create paths createReel/onUploadComplete (B-R7), listing handlers hashtag/audio/user/liked/saved/drafts share ~25-line skeleton (where + cursor + findMany + hasMore + encodeDateCursor) 6x, `{success:false 401}` boilerplate 24x.
- Shared with others: access-control, keyset util, bunny services, notifications, ad service, recommendation platform, chat (shareReelInChat), posts (comment/like/poll), public profile service (reel tabs).
- Extraction: `reel.mapper.ts` (83-270), `reel-feed.controller.ts` (341-532 + lists), `reel-upload.controller.ts` (644-1000, 2991-3069 webhook), `reel-engagement.controller.ts` (1170-1700), `reel-comments.controller.ts` (1853-2310), `reel-view-batcher.service.ts` (1699-1850; makes the in-memory batcher testable/replaceable with queue), `reel-analytics.controller.ts` (2764-2925).

##### controllers/stories.controller.ts (1220 lines)
- Responsibilities: feed + cache + grouping :37-265; CRUD :267-572; views/viewers :574-743; reactions/replies as DMs :744-1108; highlights/archive stubs :1113-1220.
- Duplicated inside: reactToStory vs replyToStory DM block (B-E5), story include x3 (B-D4), `canViewStory` + 404 preamble x4.
- Shared with: chat (messages/conversations), trust-safety, access-control, music util, bunny storage.
- Extraction: `story-dm.service.ts` (the DM send), `story-feed.service.ts`, `story-highlights.controller.ts` (stubs), `story.mapper.ts`.

##### controllers/upload.controller.ts (599 lines)
- Responsibilities: avatar/banner upload + delete with outbox cache invalidation; certificate/project/logo uploads (B-E2); generic delete; chat media upload (size/duration/type rules); multer config.
- Duplicated inside: B-E2, delete avatar/banner pair (identical structure, differ in column + event type), chat constants shared with routes (B-E3).
- Extraction: `profile-media.controller.ts` (avatar/banner), `asset-upload.controller.ts` (certificate/project/logo), `chat-media.controller.ts` (should live with chat), plus `media-limits.ts`.

##### services/feed-algorithm.service.ts (620 lines)
- Responsibilities: recommended-cursor codec (`rec:` format) :80-135, profile normalization :190-215, scoring :218-395, author spreading/fresh-unseen promotion + paging `rankFeedPage` :396-620.
- Duplicated: with feed/* (B-F1). Shared: post.util `getPostMetadata`, controllers/post.controller.
- Boundary: `recommended-cursor.ts`, `legacy-scoring.ts`, `legacy-paging.ts` - or delete once v2/unified fully rolled out.

##### services/feed/feed-signals.service.ts (580), candidate-generators.ts (573), feed-config.ts (554)
- feed-signals: batched signal loading (`loadSignalInputs` :151-425) + pure `computeSignals` :429+; helpers duplicated with legacy (B-F1). Boundary: split loader (DB) from pure signal functions (already separable).
- candidate-generators: one generator per pool; five raw SQL pools share a base predicate (B-D7). Boundary: `candidate-sql.ts` fragment helpers.
- feed-config: types + DEFAULT_FEED_CONFIG + env/JSON override loader; boundary: types vs defaults vs loader. Engagement weights duplicated by hard-coded legacy weights (B-F1).

##### utils/post.util.ts (533 lines)
- Responsibilities: stored-metadata types, reaction types/summaries, field parsers (`parseStringArrayField`, ...), URL normalization/OG scraping, type/visibility mapping, `mapPostResponse`.
- Duplicated: author mini-mapper repeated twice inside `mapPostResponse` (author + each collaborator, 12 identical field mappings), visibility mapper vs stories/reels (B-R4).
- Boundary: `post-metadata.ts`, `post-reactions.ts`, `link-preview.ts`, `post-mapper.ts`.

### Slice C - Social & messaging

##### controllers/groups.controller.ts (2651)
- Responsibilities: group CRUD + media upload (:445-585, 2012-2255); discovery/list (585-851, 1885-2012); invites and invite links (846-1380); join requests (1384-1527); join/leave/members/roles (1527-1750, 2255-2406); posts stub (1781-1885: always returns empty, "no GroupPost model"); group chat messages (2406-2651); mappers and role helpers (97-445).
- Internal duplication: join paths (BR-7, 5 copies of capacity+tx), authorization pair-fetch (DA2, 11x), `slug: generateSlug(name)` x9 (BR-8), 31 identical catch blocks, group-list mapper repeated in `getMyGroups`/`discoverGroups`/`listGroups` (:585,751,1885: same field map incl. `memberRole`, `isMember`, `slug`).
- Shared with others: `index.ts` group sockets (F1), `college-communities` (BR-7/8), `utils/access-control.util` (`canViewGroup`, `buildGroupVisibilityWhere`).
- Extraction boundaries: `group-membership.service`, `group-invite.service` (invite + link + join request), `group-message.service`, `group.mapper.ts`, `group-roles.ts` (already exported helpers :325-371).

##### controllers/chat.controller.ts (2235)
- Responsibilities: helper/DTO layer (60-340), conversation list/open/create (358-870), sync (871-1090), messages list (1097-1190), send/read/delete/edit/react (1193-1790), unread/search/message-limit/requests (1789-2230).
- Duplication: E4 helpers; BR-2 unread builders; DA3/DA4; F4 triple transaction block; F6; BR-5 limit.
- Shared: `chat-message.service`, `chat-read-receipts.service`, `chat-conversation-cache.service`, `index.ts` socket handlers, `trust-safety`.
- Boundaries: `chat-dto.ts` (mapMessagePayload + story ref + identity), `chat-visibility.ts` (blocked where, unread where), `chat-reactions.service`, `chat-message-requests.service`, `chat-sync.service`.

##### controllers/people.controller.ts (1508)
- Responsibilities: cache/cursor helpers (97-360), person-card select + mapper (363-552), relationship + mutual summary (392-490), browse/search (553-850), suggestions/passes (851-969, 1340-1400), same-college (970-1074), college search/logo (1075-1190), near-me (1192-1275), filter options (1276-1339), saved searches (1398-1508).
- Duplication: F2/BR-3 vs talk; cache tag helper E2; near-me location rule BR-10; `isBanned:false` BR-11; `getPeopleNearMe` + `getPeopleFromSameCollege` repeat "findMany + premium visibility + relationship + map" tail (:924, :1038, :1249 same 4-line sequence).
- Boundaries: `people-card.mapper`, `people-relationship.service` (extend), `people-discovery.service`, `college-search.controller`, `saved-discovery-searches.controller`.

##### services/profile.service.ts (1274)
- Responsibilities: avatar legacy migration (69-113), cache key/identifiers (114-150), profile view tracking (133), stats defaults (150), viewer relationship SQL + mapper (178-212, 660-720), GitHub backfill (214), unified content feed (245-625), core/sections/full profile (626-1274).
- Duplication: F7/F7b; connection-state mapper BR-4; `canShowLocation` BR-10 x2; hand-rolled `unified item` mapping.
- Boundaries: `profile-feed.service` (245-625, ~380 lines), `profile-cache.ts`, `profile-viewer-context.ts`, `profile-core.service`, `profile-bundle.service`.

##### controllers/talk.controller.ts (1171)
- Responsibilities: AI "talk" turn (798-910): query term extraction (131-196), people search (360-604), scoring (427-558), prompt/response (678-797), profile preview (922-1170, with GitHub/skills/experience fetch and caches).
- Duplication: F2 relationship/mutual copy (209-319); BR-1 no block checks; BR-10 raw `location`; BR-11; `isProfileOnline` E6; profile preview re-fetches data `profile.service` already builds.
- Boundaries: `talk-people-search.service`, `talk-ai.service`, `talk-profile-preview` (should delegate to `profile.service.getCoreProfile` and reuse its viewer-aware, block-aware cache).

##### controllers/connection.controller.ts (983)
- Responsibilities: send (73-238), accept (240-360), reject (361-~420), cancel (509-574), remove (575-628), lists (629-765, 766-922), status (923-983).
- Duplication: inline user select x9 (DA1), unbounded paging x4 (BR-16), status mapping (BR-4), cache tags (E3), counter decrement (BR-12), `safetyErrorResponse` handling.
- Boundaries: `connection.service` (state machine: create/reopen/accept/reject/cancel/remove), `connection.mapper`.

##### controllers/profile.controller.ts (975)
- Responsibilities: get profile (107), sections (182), feed (225), update (315-682, long field normalization/validation incl. interests diff), banner/avatar upload (683-832), activity + years (834-975).
- Duplication: block check repeated 3x inline (:287, :891, :960) plus helper `isProfileUnavailable` x3 (E5), `resolveProfileTargetId` extra query (DA6), `uniqueCacheTags` (E2). `updateProfile` is 370 lines: validation, normalization, side effects (cache invalidation, onboarding sync) tangled.
- Boundaries: `profile-update.service`, `profile-media.controller`, `profile-activity.controller`.

##### services/trust-safety.service.ts (932)
- Responsibilities: errors (99), hashing/PII masking (125-160), trust level/badges (153-195), device fingerprinting + `user_devices` (195-310), safety events (310), identity summary (337-495), block creation with device scope + counter recompute (505-695), block queries + caches (696-815), interaction asserts (819-872), tier limits (875-905), error response (916).
- Duplication inside: block pair vs set (F5); counter recount duplicates BR-12; user-eligibility check (`isBanned/suspended/restricted`) only here (BR-11 source of truth).
- Shared: everything in slice imports it; `identity.controller` overlaps trust level computing.
- Boundaries: `block.service` (505-815), `device-signal.service` (195-310), `identity-trust.service` (153-195, 337-495), `tier-limits` (875-915; already partly in `tier-limits.service.ts`).

##### services/social-proof.service.ts (914)
- Responsibilities: live/ambient stats (random `Math.floor(Math.random()*50)+10` for `activeUsersNow`/`connectionsToday`, :97-101: fabricated numbers), profile view tracking (trackProfileView, I9), profile insights/analytics (views, searches, saves, funnel; :170-690), trending/tags.
- Duplication: `trackProfileView` vs `profile-view-analytics.service` (I9); `normalizeCollege` BR-17; inline user select with `profileBadgeStyle` x4 (DA1/BR-9); date helpers `startOfToday/daysAgo`.
- Boundaries: `profile-insights.service`, `profile-view.service`, `live-stats.service`.

##### services/college-catalog.service.ts (879)
- Responsibilities: static catalog + matching/scoring (208-350), Google Places autocomplete/text search/details (369-690), college DB and directory providers (693-830), merge/dedupe (534, 830).
- Duplication: `googlePredictionToSuggestion`/`googleTextPlaceToSuggestion`/`collegeDbCollegeToSuggestion`/`directoryCollegeToSuggestion`/`toPlatformSuggestion` all build the same `CollegeSuggestion` with similar logo/domain fallback; provider fetch wrappers repeat fetch + timeout + error handling (infrastructure). `normalizeCollegeKey` BR-17.
- Boundaries: `college-catalog.static`, `college-providers/{google,db,directory}.ts`, `college-merge.ts`.

##### services/matching-engine.service.ts (861)
- Responsibilities: select shape (121), text helpers (189-240), geo (240-264), signal collectors (265-290), scoring (348-573), ranking (573-610), candidate WHERE builder (611-738), notification policy/env config (738-770), copy builders (770-861).
- Duplication: `canUsePublicCoordinates` (BR-10), `haversineKm` vs SQL haversine in location/discovery-power, `uniqueLabels/normalizeText` vs people helpers, exclusion rules BR-13.
- Boundaries: `matching-score.ts` (pure), `matching-candidates.ts` (where), `matching-notifications.ts` (config + copy). Already mostly pure and tested; split by file only.

##### controllers/people-contacts.controller.ts (603)
- Responsibilities: contact normalization/hash (40-100), `buildConnectionMetadata` (104), sync endpoints, "people you know" response (180-330), invites.
- Duplication: E1 (agent copy), BR-1 (no block/ban filter), person-card hand mapping (:255-285) parallel to `people.mapUserToPersonCard`.
- Boundaries: `contact-sync.service`, reuse relationship service.

##### Other >500 lines in slice
- `services/chat-message.service.ts` (741): helpers E4, `sendChatMessage` (444-741: single raw SQL/atomic write + outbox), `getExistingMessageResult` (393). Boundaries: `chat-identity.ts`, `chat-message.write.ts`.
- `controllers/skills.controller.ts` (1261): passport builder (216-523, 300 lines), endorsements, verification links, skill-swap (804-1261). Missing block checks (BR-1), non-atomic transitions (BR-15). Boundaries: `skill-passport.service`, `skill-swap.service`.
- `controllers/identity.controller.ts` (633): phone, student-email OTP, ID doc, badge claim. Overlap: `college-communities.getTrustedCollegeVerification`.
- `index.ts` chat/group/presence socket handlers (~1000 lines of the 3113): the REST-vs-socket divergence source (F1, F4, F6, BR-6). Boundary: move handlers to `sockets/chat.socket.ts`, `sockets/group.socket.ts`, each delegating to the same services the controllers use. `sockets/index.ts` itself is only a 26-line IO holder + `evictUserFromGroupRoom`.

### Slice D - Notifications & infra

##### services/notification.service.ts (1699 lines, `// @ts-nocheck`)
- Responsibilities: notification type union; Prisma include/format; profile-view batching state machine (353-506: window 3 days, batch 15, copy builder 201-242); outbox enqueue helpers; 33 `createNotification` callers wrapping ~35 typed `notifyX` methods (domain copy for streaks, XP, connection, hackathon, skill swap, college, post, reel, mention, identity); mark read/read-all/unread count/cleanup.
- Duplicated inside: each notifyX = build title/body, createNotification, push (see F-1); 33 `createNotification(` calls; `${preview.slice(0,50)}${preview.length>50?'...':''}` truncation written 6+ times (comment, reply, mention, reel comment/reply); `Object.fromEntries(Object.entries(data).filter(...).map(String))` stringifier written twice (1310, 1350) and implicitly elsewhere as manual `String(x)`; reel milestone number formatter inline (1535-1539); `tags: ['notifications:${userId}']` x5; try/catch + `console.error` only in 2 methods, others let errors bubble (callers use `.catch(console.error)`).
- Shared with other files: copy with push-notification.service.ts; include/format with notifications.controller.ts; `areUsersBlocked` rule with trust-safety.service (23 call sites repo-wide); profile-view dedup consumed by social-proof.service.ts:164.
- Natural extraction boundaries: (1) notification-types + payload mapper (include/format/realtime envelope) ~lines 14-101, 244-290; (2) profile-view batching module 103-242 + 353-506; (3) copy/template builders per domain (hackathon, skill swap, college, identity, social) 585-1120; (4) social/reel notify methods 1124-1562 collapsed into one table-driven `notifySocial(type, ...)`; (5) read-state/inbox queries 1571-1696 merged with controller query logic (B-3). (No splitting performed.)

##### services/reengagement-notification.service.ts (1338)
- Responsibilities: IST slot config/parsing (167-232); campaign copy builder (309-438, 10 tones); growth snapshot (440-623); candidate scoring/selection (625-789); audience/eligibility (791-874); admin preview/run-for-user (918-1086); window calc (1088-1116); delivery reservation and send (1118-1237); campaign loop (1239-1338).
- Duplicated inside: eligibility chain (preview 1002-1026 vs getEligibleAudienceWhere 791-807); user snapshot select x2; `previewReengagementForUser` empty-result object literal repeated 3x (~20 fields each); `currentUser` object construction repeated 3x (984, 1179, buildReengagementCopy input); `lookbackDays/Boundary` computed in 2 places; `loadMeaningfulGrowthSnapshotMap` called 3x with duplicated window context derivation (`getCampaignDayContext(now, getCurrentReengagementWindow(now))` recomputes window twice in runReengagementForUser 1059,1070).
- Behavioral risks: unbounded `prisma.user.findMany` for the whole eligible audience in one query (1256, no `take`/cursor; memory scales with active users), then batches of 8; `findBestMatchCandidate` runs 1-2 queries per user per hour (N+1 at audience size).
- Shared with other files: device-token rule, enabled-flag parser (match-availability), push send (`pushReengagementNudge`), normalizeText.
- Extraction boundaries: slot/time module (167-236) -> shared time util; copy builder 309-438 (pure, already exported for tests); growth-snapshot loader 440-623 (reusable by engagement); candidate selection 625-789; delivery ledger 893-916 + 1118-1237; admin preview 918-1086.

##### services/github.service.ts (691)
- Responsibilities: OAuth token exchange, REST (profile, repos pagination, languages), GraphQL contribution calendar (410-510, ~100 lines incl. query and mapping), stats/top-repo computation (339-408), sync orchestrator `syncGitHubData` (539-691) with `mapWithConcurrency` (515-537, only copy in repo; grep for other implementations found none).
- Duplicated inside: 5 error-mapping blocks and 5 header/timeouts literals (I-4); `console.*` 12 sites; reads GITHUB_CLIENT_ID/SECRET at module load (17-18).
- Shared: breaker util; DB writes in sync (user profile table) not analyzed.
- Boundaries: `githubClient` (HTTP+error mapping) / `githubStats` (pure calculations) / `githubSync` (DB). `mapWithConcurrency` -> utils.

##### services/hackathon-import.service.ts (844, `// @ts-nocheck`)
- Responsibilities: 4 source scrapers/mappers (devfolio 300-387, mlh 388-434, devpost 435-489, hackerearth 490-550), text/date cleaners (85-160), slug (160-179), upsert (551-603), 4 importer wrappers (605-755, ~100% identical loops), instant notification fan-out (223-298), lazy auto-import (775-810), orchestration (812-844).
- Duplicated inside: the four `importXHackathons` share the try { fetch; map; upsert; if created notify }/catch { result.error } skeleton (4 copies; devpost adds paging); `notifyMatchedUsersAboutNewHackathon(...).catch(console.error)` x4; `{ connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 }` x4; source dispatch if/else chain (816-826) that a `Record<Source, importer>` replaces; ImportResult literal x4.
- Shared: cleaners with hackathons.controller/college-communities.controller; audience query with controller + digest (F-3); env config at top (9 env reads, 3 parse styles).
- Boundaries: `sources/{devfolio,mlh,devpost,hackerearth}.ts` (fetch+map), `importRunner` (generic loop), `hackathonNotifications` (audience + fan-out), `autoImport` scheduler.

##### services/push-notification.service.ts (696)
- Responsibilities: mode resolution (56-143), `sendToUser` FCM multicast with token cleanup (158-279), batch sender (281-294), ~20 typed `pushX` copy/payload builders (296-693).
- Duplicated inside: `sendToMultipleUsers` (batches of 10, parallel) vs `pushGroupMessageToUsers` (sequential loop, 529-549) - two fan-out strategies; message preview truncation `length > 100 ? substring(0,97)+'...'` x2 (467, 499); `pushNewConnection` just aliases `pushConnectionAccepted` (403); streak copy duplicates notification.service streak copy (notifyStreakMilestone 511 vs pushStreakAchieved 366: different milestone sets: push [7,14,30,50,100,365] vs service has no milestone logic - callers decide).
- Shared: copy with notification.service.ts; token deactivation rules only here (invalid-registration-token, not-registered; other error codes e.g. `messaging/mismatched-credential` not handled); no block/preference/quiet-hour check in sendToUser, so everything above relies on callers.
- Boundaries: `pushTransport` (sendToUser/token mgmt), `pushPayloadBuilders` (typed builders), `pushMode` config. Note: `sendEachForMulticast` is limited to 500 tokens per call; the code sends all of a user's active tokens in one call without chunking (fine for per-user, unbounded if a user has >500 tokens - low risk).

##### infrastructure/cache/redis-cache.service.ts (623)
- Responsibilities: two-tier cache (in-process Map LRU-ish + Redis), tag index with Lua invalidation, SWR envelopes, single-flight with Redis lock + 50ms polling, TTL jitter, metrics, pattern delete, fixed-window counter.
- Duplicated inside: memory and Redis branches of get/set/del/delPattern/invalidateTags/incrementFixedWindow each re-implement the same logic twice (backend fork per method); `fixedWindows` Map cleanup scans the whole map on every call (O(n) per request); `delPattern` semantics differ between memory (regex/glob?) and Redis SCAN (not verified).
- Shared: facade cache.service.ts (I-6); two instances (`redisCacheService` role cache, `redisSessionStore` role critical) share class but not memory maps.
- Boundaries: `CacheBackend` interface with `MemoryBackend`/`RedisBackend` removing the per-method fork; `SingleFlight`; `FixedWindowCounter` (could back rate-limit.service too).

##### Other files over 500 lines in slice
- utils/email.util.ts (709): Resend client setup + availability probe (domains list with 5-min cache, retry-after parsing, error classes 20-410), HTML escape/logo resolution (410-458), `sendEmail` (459-510), two ~90-line HTML templates `sendPasswordResetEmail` (513-615) and `sendVerificationEmail` (618-709) which share layout/logo/footer markup (near-duplicate template bodies; extract `renderEmailLayout`). Constructs `new Resend(process.env.RESEND_API_KEY || 're_placeholder')` at import (line 9) while `getEmailConfig` re-reads the key per call (115) - key rotation without restart is half-supported.
- workers/index.ts (442): 9 processors + factory; `processAnalyticsEvents` and `processMediaProcessing` are logging stubs ("worker.stub.*"), `getCacheInvalidationPayload` / `processAnalyticsEvents` repeat the "job.data.event?.payload || job.data" unwrapping idiom (3 times: 173-180, 234-238, getPayload for notification uses `job.data.event.payload` strictly at 108 and 288 - inconsistent: realtime/notification/connection processors require the envelope, cache/analytics accept both shapes).
- infrastructure/redis/client.ts (357): fine; see I-2.

### Slice E - Premium & admin

(>~500 lines; no splitting now, only boundaries.)

**controllers/admin.controller.ts (2982)** - Responsibilities: admin 2FA (TOTP crypto :37-120, 299-520), dashboard stats (:519), notifications/re-engagement ops (:601-860), user CRUD/ban (:862-1180), posts/reels/groups moderation (:1184-1860), chat storage purge (:1860-2050), identity review (:2055-2330), safety actions (:2334-2500), reports (:2508-2965), audit log stub (:2972). Duplicated inside: moderation state changes (B11), pagination parsing x7 (I3), mapping helpers, 39 inline 401 checks. Shared with: trust-safety.service, premium-admin (users), reports.controller (report rows), identity services. Extraction boundaries: admin-auth (2FA), admin-users, admin-content, admin-groups, admin-identity-review, admin-reports/moderation-actions service, admin-notifications.

**controllers/professional-fields.controller.ts (2062)** - Responsibilities: profile CRUD for skills, experience, education, projects (+feature), certificates, achievements, interests (7 entities x create/update/delete/get). Duplicated: ownership check (D3, 14x), validation (I4, ~24x), cache invalidation, date-range logic, response/error blocks. Shared with: tier-limits (project quota), people search reindex, skills.controller (skill passport). Extraction: generic `crudHandlerFactory(entity, schema)` + per-entity schema; `profile-cache.service` for invalidation.

**controllers/engagement.controller.ts (1927)** - Responsibilities: streak read model (:79-153, 253), weekly goals (:156), reward cards (:273-350), daily matches/people-like-you/hidden gem (:380-730, discovery logic that overlaps matching.controller and people.controller), trending/live (:732-870), leaderboard (:869-1130), nudges (:1135), connection limit (:1277), session summary/celebration (:1311-1500), streak history/dashboard/public (:1507-1640), streak freeze/shield/leaderboard/visibility (:1638-1850), `updateEngagementStreak` helper (:1855). Duplicated: date helpers (E3/F2), connection-exclusion set x3 (D2), streak rules (B7), user select shapes (D6). Shared with: progress.service, activity.service, engagement.service (cron), tier-limits, reward-cards.service, premium-visibility. Extraction: streak.service (read+write), engagement-discovery.service, engagement-leaderboard.service.

**controllers/skills.controller.ts (1261)** - skill passport builder (:216-523: aggregates GitHub, endorsements, projects, verification), endorsements (:597), verification links (:694-786), skill swap suggestions + requests + sessions (:804-1261). Duplicates: `areConnected` (F4), user-card formatters, `normalize*`/`uniqueStrings`. Shared with: professional-fields (skills), premium-access (verified-skills badge, :492-493). Missing block checks (B13). Extraction: skill-passport.service, skill-endorsement.service, skill-swap.service.

**controllers/games.controller.ts (1298)** - game stats/XP history/leaderboard (:69-250), daily trivia (:254-460), wordle (:463-660), question/coding problem fetch+submit (:663-830), quiz battles (:833-1090), typing race (:1093-1290). Duplicated: local-time day windows (B8), `awardUserProgress` call blocks x3 (B10), `Math.min(50, Number(limit))` (I3), `game_stats` upserts that overlap arcade.service (:509-541). Shared with: progress.service, arcade.service (overlapping game_stats writes, leaderboards). Extraction: trivia.service, wordle.service, typing.service, quiz-battle.service; common `game-rewards.service`.

**controllers/admin-premium.controller.ts (1172)** - premium overview/revenue (:134-300), settings (:301), user list/detail (:354-545, 832-1035), overrides (:552), admin cancel (:649), checkout events (:721), admin DM (:1038-1172, F5). Duplicated: premium snapshot recomputation (B2), subscription select (D1), active-premium filter (B1), chat send (F5). Shared with: premium-access.service, premium.controller (cancel), chat. Extraction: premium-admin.service (read models), admin-messaging.service.

**controllers/hackathons.controller.ts (885)** - hackathon list/create/save (:271-520), team formation + applications (:521-840: owner membership, group creation, respond transaction with group_members upsert), notifications for skill matches (:223-270). Duplicated: text/slug helpers (E5), status derivation (F6), quota (B6). Shared with: hackathon-import.service, tier-limits, groups (team group), notifications. Extraction: hackathon-team.service (apply/respond/limits), hackathon-format.ts.

**controllers/premium.controller.ts (851)** - subscription read, creator-pro, profile boost, Razorpay checkout create/verify/webhook (:370-730), Google Play verify, cancel. Duplicated: `logPremiumCheckoutEvent`+503 config guards repeated in create and verify (:376-395, :536-548), cache invalidation placement (B3), Razorpay error mapping (:71-130) overlapping GooglePlay error class. Shared with: premium-razorpay/checkout/google-play/access services. Extraction: premium-checkout.controller (razorpay), premium-play.controller, premium-webhook.controller.

**controllers/events.controller.ts (596)** - event list/upcoming/mine/get/create/rsvp with cursor serializers; RSVP capacity race (B16). Boundary: event-rsvp.service. **controllers/reports.controller.ts (625)** - five report endpoints around one helper; cohesive, extract `buildEvidenceSnapshot(type)` per type only.

**services/premium-access.service.ts (749)** - env-driven plan/pricing config (:130-260), predicates (:420-482), agent access (:296-330), cancel/revoke (:484-551), snapshot (:553-657), plan config/serialization (:658-732), checkout event log (:733). Duplicated inside: F3 predicates. Shared with: every premium service and ~12 controllers. Boundaries: premium-config, premium-entitlement (pure predicates), premium-subscription.repo (cancel/revoke/upsert shared by razorpay/google), premium-snapshot.

**services/activity.service.ts (778)** - activity write (:37-160), streak calc (:162-257, dup of progress), user stats aggregation incl. long try/catch-per-model counts (:268-420), heatmap/years/summary read models (:431-778). Shared with: progress.service (XP/level, streak), profile.service. Boundaries: activity-write, activity-heatmap (cached read model), user-stats-aggregator.

**services/arcade.service.ts (732)** - Redis runtime state/locks (:104-260), room lifecycle (:315-465), reward calculation + caps (:466-496), game stats/streak (:509-541), results (:543-600), finish (:601-675), history/leaderboard (:676-732). Shared with: games.controller (game_stats), progress.service. Boundaries: arcade-room-state, arcade-rewards, arcade-leaderboard; move streak to shared streak util.

**services/managed-ad.service.ts (639)** - targeting normalisation/matching (:115-296), CTA validation (:296), placement/slot math (:231-350), target profile loading (:357-440, premium states B1/D1), selection (:499-583), event recording (:584-640). Boundaries: ad-targeting (pure), ad-selection, ad-events.

**services/google-play-premium.service.ts (521)** - config/credentials (:99-160), API client (:161-208), validation (:237-352), token ownership guard (:353), verify+upsert+ack (:375-521). Duplicates Razorpay finalisation (B5). Boundary: shared `applyActivation`.

**services/progress.service.ts (537)** - XP/coin rules constants (:1-47), level math (:58-118), ledger helpers/idempotency (:120-215), awards (:215-330), spend (:330-410), streak (:415-466), overview (:468-537). Shared with activity/profile/games/learning/arcade. Boundaries: xp-rules.config, level.util, ledger.service, daily-streak (single source for F1).

**services/reward-cards.service.ts (520)** - candidate scoring/diversification (:94-260), loading (:261-330, B13 block gap), response (:331-455), event log (:455). Overlaps matching-engine/people discovery scoring; boundary: reuse candidate-exclusion service.

### Slice F - API, agent, discovery

##### index.ts (3113 lines)
- Responsibilities: process bootstrap/env validation; CORS; Redis shared presence; Socket.IO auth + per-event sanitization middleware; 39 socket handlers (agent voice, posts, comments, polls, chat, groups, reels, stories, location); 6 transactional fanout writers; express middleware chain; health/metrics; 57 router mounts; MCP; startup/shutdown.
- Duplicated inside: the transaction template (`$transaction` -> write -> recount -> envelope -> `enqueueRealtimeFanout` -> `enqueueCacheInvalidation`) about 5x; `postRooms` ternary 3x (736, 878, 1043); `maxWait/timeout 10_000` 6x; per-handler `getSocketUserId` + `emit('error')` guard about 20x; per-handler error-message mapping.
- Shared with other files: all of F5; E3; D1; D3.
- Extraction boundaries: (1) `sockets/agent.socket.ts` (1371-1503); (2) `sockets/post.socket.ts` + `services/post-engagement.service.ts` (686-1068, 1504-1675); (3) `sockets/reel.socket.ts` + service (1069-1235, 2472-2557); (4) `sockets/chat.socket.ts` (1676-2173); (5) `sockets/group.socket.ts` (2174-2471); (6) `sockets/presence.ts` (289-600); (7) `bootstrap/express.ts` (2705-2970); (8) `bootstrap/lifecycle.ts` (2972-3113). `sockets/arcade.socket.ts` is the existing precedent.
- `// @ts-nocheck` on line 1 disables type checking for the whole file (e.g. `error?.userMessage` on an unknown catch at ~1445), which is why the divergences above are not caught.

##### agent/tools.ts (2519 lines)
- Responsibilities: tool schemas (:216-372), current-user prompt-context builders (:421-593), people-search helpers (:629-752), UI intent factories (:795-836), connection metadata (:838-962), policy gating `maybeGateAction` (:1017), and ONE ~1400-line `switch` in `executeAgentTool` (:1106-2519, 15 cases).
- Duplicated inside: each case repeats `blockedAction(actionRecord(...))` + `output:{status:'blocked',reason}` scaffolding (about 40 blocks); `Math.min(N, Math.max(1, Number(args.limit)||k))` 4x; `clip()` normalization 10x; `getOrCreateConversationForUsers` (:994).
- Shared with other files: BR1-BR6, BR13, F3, D7.
- Extraction: one file per tool (people, connections, chat, groups, profile, posts, growth, notifications, ui) with a registry; `agent/user-context.ts` for prompt builders; each tool delegates to a domain service.

##### agent/orchestrator.service.ts (1317 lines)
- Responsibilities: provider config (OpenAI/Gemini), Gemini function-declaration translation, provider error mapping (:285-450), quota-fallback turn with regex intent routing (:470-725), system prompt (:730), main Gemini turn + tool loop (:790-1225), STT/TTS (:1226-1275), voice turn (:1277).
- Duplicated inside: F2 (A vs B); OpenAI vs Gemini branches in `mapProviderError`; autonomy-policy construction (`getPremiumAccessSnapshot` -> `resolveAgentAutonomyPolicy`) also in realtime-voice.service.ts:1152 and agent.controller.ts:49-60.
- Shared with realtime-voice: E1, F2, I6, BR12.
- Extraction: `agent/provider-errors.ts`, `agent/fallback-router.ts` (:470-725), `agent/tool-runner.ts`, `agent/audio.service.ts` (:1226-1317), `agent/prompt.ts` (:730).

##### agent/realtime-voice.service.ts (1241 lines)
- Responsibilities: OpenAI Realtime websocket lifecycle (:374-410, `startSession` :1014), voice system prompt (:188-241), event handlers (:550-752), tool handling (:753-870), turn finalization (:900-1010), surface update/interrupt/prompt/stop/cleanup (:1132-1241).
- Duplicated inside: E1 (5 helpers), F2 (C), own error mappers (I6), own OpenAI client (F6).
- Extraction: `agent/realtime/events.ts`, shared tool-runner, `agent/realtime/session-store.ts`.

##### controllers/ai-chat.controller.ts (1116 lines)
- Responsibilities: 9 endpoints (7 helpers + assistant + career), prompt assembly, JSON extraction (`extractJsonArray/Object` :236-290), history normalizers (:356-422), free quota (:424-445), AI error responder (:111).
- Duplicated inside: each helper endpoint (:536-958) repeats auth guard -> clamp -> `getConversationContext` (:461) -> system prompt -> `aiService.complete` -> parse -> respond; E2; JSON extraction vs talk.controller.ts:652 `parseAIJson` (same `{...}` regex fallback; ai-chat returns null, talk falls back to `{answer: raw}`).
- Extraction: `ai/prompts/*.ts`, `ai/json-extract.ts`, `ai/ai-http.ts`, `ai/assistant-quota.ts`.

##### services/discovery-power.service.ts (1002 lines)
- Responsibilities: premium filter gating + suggestion quota (:10-210), discovery pass/rewind (:248-340), search term builders (:344-495), nearby SQL (:527), people `where` builder (:570-700), saved searches CRUD + digests (:700-1002).
- Duplicated inside: three array-field case-insensitive match strategies (`findCaseInsensitiveArraySearchUserIds`, `searchVariants`, `normalizeIntentValues`).
- Shared: E9, F3, F4, BR5/BR6 (callers must apply blocks), saved-search matching (`findSavedSearchMatchIds` :750) reuses the where builder indirectly.
- Extraction: `discovery/quota.ts`, `passes.ts`, `where-builder.ts`, `nearby.ts`, `saved-searches.ts`.

##### services/recommendation-platform.service.ts (573 lines)
- Responsibilities: signed cursor encode/decode (:97-143), session snapshots + cache (:145-310), client event validation/ingestion (:311-455), preferences/feedback (:456-525), authoritative outcome (:526), retention cleanup (:567).
- Duplicated inside: `allowedSurfaces/allowedEntityTypes` runtime sets (:85-86) duplicate the union types in recommendation-engine.service.ts:3-4 (can drift). Feedback raw SQL read also in feed-eligibility.service.ts:57 and home-recommendation.service.ts:89.
- Extraction: `recommendation/cursor.ts`, `sessions.ts`, `events.ts`, `feedback.ts`.

##### services/public-discovery.service.ts (597 lines)
- Responsibilities: eligibility (:133), candidate loading (:200), scoring (:272), embedding (:166-200), people search/list/profile (:324-445), visibility settings (:447-470), reindex (:469), opportunities (:505), sitemap (:579).
- Duplicated inside: `isPublicUserEligible` repeated as inline Prisma filter (:217-222) and again in the profile fetch (:373); the candidate select list repeated 3x (:246-270, :373, :474). Shares F3, F6, F7, BR5.
- Extraction: `public-discovery/eligibility.ts`, `scoring.ts`, `embedding.ts`, `people.ts`, `opportunities.ts`.

##### agent/session.service.ts (566 lines)
- Responsibilities: DB-or-memory storage mode resolution (:27-98), in-memory fallback session (:98-168), session mapping (:169-260), ownership (`requireSession` :286, also used by index.ts:1371), message append (:295), action logging with redaction (:341-453), user preferences (:454-565).
- Duplicated inside: DB-mode and memory-mode branches inside most public methods.
- Extraction: `SessionStore` interface with DB and memory implementations; move `getUserPreferences` to a preferences service.

## Recommended Consolidation Opportunities

Proposed order for the later refactor. It prioritizes **closing behavior gaps where the stricter implementation is already known**, then shared plumbing. In every case, first write characterization tests for each existing entry point, then decide per difference which behavior is authoritative. Do not merge blindly.

| # | Consolidation | Resolves | Risk of change | Notes |
|---|---|---|---|---|
| 1 | **One visibility/safety guard** (`assertCanInteract`, `assertCanView`, `excludeUnavailableUsersWhere`) built on the existing `trust-safety.service` block API | Block/ban/suspension gaps in agent, socket, talk, contacts, skills, nearby, follow, reels, recommendation-learning | High | Do first. Decide the product rule explicitly (bilateral blocks, device-scoped blocks). Add parity tests between `canViewX` and `buildXVisibilityWhere`. |
| 2 | **Domain services shared by REST, socket and agent**: ConnectionService, ChatService (single write path), GroupMembershipService, PostEngagementService | Agent bypass, socket bypass of limits, REST/socket chat drift, group capacity race, counter idempotency | High | `src/index.ts` socket handlers and `agent/tools.ts` become thin callers. |
| 3 | **Moderation actions service** (remove content, ban, suspend, restrict) used by admin and report paths | Admin hard-deletes without cache/media cleanup, report-driven ban skipping proximity invalidation, admin owner assignment | High | Pair with admin group role/removal via the groups service. |
| 4 | **Account-state gate** (`assertAccountCanAuthenticate`) for login, refresh, Google OAuth, auth-gate | Missing suspension check on OAuth, three "email not verified" codes | Med | Auth: keep exact error codes where clients depend on them. |
| 5 | **Reel parity**: use `buildReelVisibilityWhere` everywhere, validated visibility enum, fix `onUploadComplete` mass assignment and draft/webhook status handling | Reel leaks and status clobber | Med-High | Needs regression tests (blocked author in For-You, case sensitivity, scheduled reels). |
| 6 | **Premium entitlement resolver** + `activePremiumWhere`; **subscription lifecycle service** | ~12 divergent predicates; Razorpay/Google Play/admin write drift | Med-High | Explicit per-feature treatment of admin and CreatorPro. |
| 7 | **Notification delivery gate** for in-app + push, plus outbox attempt cap and shared backoff | Push bypassing self/block suppression, infinite outbox retry | Med | Also shared `getPushAudienceWhere`; fix circuit breaker counting 4xx. |
| 8 | **Streak / date-window service** (one UTC-day util, one daily-streak calc) | Inert freezes, unscheduled jobs, local-time `setHours` | Med | User-visible behavior change; needs a product decision on time zone. |
| 9 | **Feed eligibility gate** across rankers; retire the legacy ranker once v2 is GA | hide-author / not-interested / banned filters missing on legacy paths | Med | Shadow-compare before cutting over. |
| 10 | **Relationship graph service** (accepted ids, mutual counts, status mapper) | 6 mutual-connection variants, 8 status-mapper copies | Med | Mutual-connection scan cutoff differs per site; pick one. |
| 11 | **HTTP plumbing**: `parsePagination` with a hard max, `AuthRequest` alias + `getAuthUserId`, `asyncHandler`, error envelope with backward-compatible `error` key | ~21 unbounded/NaN limit sites, ~400 auth guards, ~600 try/catch blocks | Low-Med | Mechanical. Do incrementally. Highest volume, lowest risk, but keep response text parity. |
| 12 | **Mechanical exact-dupe cleanup** (agent helper copies, `getAITier`, `buildGroupMessagePreview`, `mediaWriteLimit`, chat upload middleware, `parsePositiveInt` x6, email regex, `isUniqueViolation`) | Exact copies | Low | Confirm intent for the shared `mediaWriteLimit` bucket first. |
| 13 | **Config/Redis/AI-client factories** (central env module, OpenAI client factory honoring `AI_API_KEY`) | Scattered `process.env`, two Redis stacks, three backoff definitions | Low-Med | Keep the two Redis instance families separate. |
| 14 | **Shared selects / DTO mappers** (`PUBLIC_AUTHOR_SELECT`, user card select, comment DTO naming) | Data-access duplication | Low | Only where the shape is genuinely the same. |
| 15 | **Split `src/index.ts`** along the documented boundaries | 3113-line `@ts-nocheck` entry file | Med | After services in (2) exist, so handlers move as thin wrappers. |

Per-slice rankings with full rationale are below.

### Slice rankings (verbatim from analyses)

#### Slice A - Cross-cutting

1. **Single domain service for content removal + safety enforcement** (B2, B3): one `removeContent`/`applySafetyAction` used by user, admin, and moderation paths. Fixes: admin hard-delete skipping cache/media (post, reel), report-driven ban/suspend skipping proximity invalidation, inconsistent session revocation. Risk High, payoff High.
2. **ConnectionService.sendRequest** used by HTTP and the AI agent tool (B8): closes the agent bypass of block/ban/trust-tier checks. Risk High, payoff High (security-relevant).
3. **`assertAccountCanAuthenticate` shared by login/refresh/Google OAuth/gate** (B5): add missing suspension check on Google sign-in; unify the three "email not verified" codes. Risk Med, payoff High.
4. **Admin group role/removal through groups service** (B4): stop admin path creating extra owners and skipping socket eviction/cache invalidation. Risk Med, payoff Med-High.
5. **`parsePagination` helper + hard max everywhere** (I3): fixes 14+ unbounded `take` sites (connections/follow/social-proof/engagement/games/admin) and 7 NaN->500 sites; trivial to adopt incrementally. Risk Low-Med, payoff High.
6. **Central error pipeline: `AuthRequest` alias, `getAuthUserId`, `asyncHandler`, typed `ApiError`, `SafetyActionError`/Prisma mapping** (E1, F1, I1, I2): removes ~400 auth guards and ~600 try/catch blocks, adds requestId logging uniformly. Risk Med (response text parity), payoff High (volume).
7. **Named entitlement predicates on the premium snapshot** (B7): make CreatorPro/admin/premium inclusion explicit per feature; kills duplicated `getAITier`; remove the dead `agent_limit_reached` path or implement it.
8. **Visibility contract tests + literals** (B1): parity test between `canViewX` and `buildXVisibilityWhere` for isActive/expiry/case; document block-cache staleness.
9. **Shared user card select/mapper** (D3) and `RESOURCE_UNAVAILABLE` + `blockedExclusion` helpers (D1): moderate payoff, low risk if done as additive helpers.
10. **Mechanical dedupes**: `mediaWriteLimit` (E2), chat upload middleware/constants (E3), image-upload factory (E6), EMAIL_REGEX/isUniqueViolation (E4/E5), email layout (I6), OTP issuance helper (F3). Low risk, low individual payoff.

Notes on confidence: findings in B2, B3, B4, B5 (oauth), B8, D1 (recommendation-learning), I3 were confirmed by reading both code sites. Items marked Med (B1 case/staleness, B6, B7 intent, B9, I4 intent, I5 multipart coverage, D4) are based on partial reads or product-intent assumptions.

#### Slice B - Content

1. Reel visibility & block rule unification (B-R1, B-R4, B-R7): make every reel list use `buildReelVisibilityWhere` and a single validated `Visibility` enum; fix `onUploadComplete` mass assignment; fix draft/webhook status clobber and `publishDraft` forcing public. Highest privacy impact; moderate code size. Needs regression tests: blocked-author in For-You, reel visibility case, scheduled reel leakage.
2. Policy parity for reel actions (B-R2, B-R9): trust-tier limits for reel/story/reel-comment, block/interaction checks on reel comments and comment likes, `canViewReel` + block check on reel-comment mention notifications, `isHidden` filtering.
3. Single feed eligibility gate (B-R3, B-F1, B-F2): bring hide-author/not-interested/reported/banned filtering to every ranking path, then retire `feed-algorithm.service.ts` and `buildFeedRecommendationContextForUser` once v2/unified are GA.
4. Engagement toggle service (B-R6, B-R5, B-R8, B-D6, B-R10): one atomic, unique-violation-tolerant like/save/share/poll/comment-count implementation with consistent notification and realtime policy; add `post_shares`.
5. Content-to-DM plumbing through `sendChatMessage` (B-E5).
6. Reel/story/post report pipeline unification (B-R11).
7. Shared selects/includes/mappers (B-F4, B-F5, B-F6, B-D4): `PUBLIC_AUTHOR_SELECT`, `postResponseInclude` export, `storyInclude`, comment DTO naming (`replyCount` vs `repliesCount`).
8. Pagination standardization (B-D5, B-D1): signed keyset everywhere, `clampPageSize`, filter-in-SQL for saved/liked lists; fix unbounded `getStoryViewers` limit.
9. Infra tidy (B-I1, B-I2, B-I3, B-I5, B-I6, B-E3, B-E1): asyncHandler, shared `mediaWriteLimit`/size constants, `webBaseUrl()`, remove dead direct-upload path, move boost safety pause off the read path, outbox realtime for reels/stories, unify story delete broadcast.
10. Do NOT consolidate: public discovery (B-N1), reel ranking (B-N2), boost placement policy (B-N7), token trust domains (B-N5).

#### Slice C - Social & messaging

1. **Unified visibility/safety guard** (BR-1, E5, BR-11): `excludeUnavailableUsersWhere`, `assertCanView(viewer, target)`, `activeUserWhere()`. Fixes block bypass in talk, contacts, skills, nearby, mutual info. Highest risk, moderate effort.
2. **Chat service as single write path for REST + socket** (BR-6, F4, F6, E4): move edit/delete/react/read to `chat-message.service` with outbox + cache invalidation + streak side-effects; fixes `isDeleted` edit hole, missing story DTO, stale caches.
3. **Group membership service** (BR-7, BR-8, F1, DA2): atomic capacity (`updateMany ... memberCount < maxMembers`), consistent already-member/private semantics, college community counter reconciliation, persisted slug, shared group message path with limits.
4. **Single unread/visibility query builder in chat** (BR-2, DA4).
5. **Relationship graph service** (BR-3, BR-4, F2, F3, E1, BR-12): accepted ids (bounded, cached), mutual counts, status derivation, counter refresh. Removes 6 + 8 copies and fixes presence-room cut at 500.
6. **Privacy-aware DTO layer** (BR-9, BR-10): `publicBadge`, `publicLocation`; fix `talk` preview raw `location`/`profileRing`, and per-viewer caching.
7. **Enforce or delete the stranger-message limit** (BR-5).
8. **Shared HTTP plumbing** (IN1-IN6, BR-16, E2, E5): `parsePage`, `asyncHandler`, tag helper, structured logging. Mechanical, lowest risk, widest reach.
9. **Selector module for user shapes** (DA1) and **college/slug normalizers** (BR-17, BR-8).

#### Slice D - Notifications & infra

1. B-1 Push bypasses block/self suppression (16 of 23 notify+push sites): one `deliver()` gate for both channels. Highest user-visible/safety impact. Risk Med, Conf High.
2. I-3 Circuit breaker counts 4xx as failures (GitHub 404 repos open the circuit for 30s) + SDK maxRetries nested in breaker + raw fetch/OpenAI paths bypassing breaker. Add `isFailure` predicate, one OpenAI client factory. Risk Med, Conf High.
3. F-2 Outbox dispatch retries forever at fixed 5s with no attempt cap (outbox/dispatcher.ts:142-167); add max attempts/quarantine and share backoff policy. Risk Med, Conf High.
4. B-3 Unread count vs inbox list rules diverge (blocked actors, duplicate connection_request collapse); delete dead `notificationService.getUnreadCount` or unify. Risk Low, Conf High.
5. B-4/B-5 Notification frequency and audience rules scattered across 4 dedup schemes; add a per-user daily push cap and shared `getPushAudienceWhere`; reengagement unbounded user query. Risk Med, Conf Med.
6. F-3 / D-5 Hackathon audience queries (3 variants) and cleaners/slugify (5 copies); extract shared user-signal `where` builder and text util. Risk Med/Low, Conf High.
7. I-1/E-1/I-8 central env + `parsePositiveInt` (6 exact copies, 59 boolean parse sites, 3 falsy-lists) and a time util for IST/day keys. Risk Low, Conf High.
8. I-2 Redis client/queue/worker factories (2 stacks, 3 backoff definitions). Risk Med, Conf High; keep instances separate (N-2).
9. D-1/D-3 Notification include/formatter (actor `profileBadgeStyle` drift) and outbox enqueue helper usage (3 enqueue styles). Risk Low, Conf High.
10. Housekeeping: delete unused `deleteOldNotifications` or schedule it; replace console.* with pino in slice files (I-5); hackathon importer loop and github error mapping (I-4) collapse to table-driven code.

#### Slice E - Premium & admin

1. **Streak/date-window service** (B7, B8, F1, F2, E3): one UTC day util + one daily-streak calc + category streak writer; fix inert freezes, wire/delete the 3 unscheduled jobs, kill local-time `setHours` in games. Highest user-visible risk; moderate effort.
2. **Single premium entitlement resolver + `activePremiumWhere`** (B1, B2, F3, D1): one place to decide premium/creator-pro/admin, used by limits, visibility, ads, admin filters/lists.
3. **Subscription lifecycle service** (B3, B4, B5): shared activation/cancel/revoke with lock, idempotency, override handling, cache invalidation; add refund webhook + Google Play sync.
4. **Rewards config + guards** (B10, E4, E6, B9): central XP/coin table, caps, interview/learning anti-farm fixes, leaderboard metric cleanup.
5. **Moderation actions service** (B11, B12): one implementation of ban/suspend/restrict/remove used by direct admin and report-driven paths; centralise report guards.
6. **Candidate-exclusion/block service** (B13, D2): replace inline connection sets and the mislabeled `loadBlockedUserIds`, and add block checks to skills/hackathons/engagement discovery.
7. **Limits config** (B6): one table feeding quotas, messages, entitlements; fix hackathon re-apply bypass and count-then-write races.
8. **Controller boilerplate** (I1, I3, I4, D3): `requireAuth` + shared request type, `parsePagination`, ownership-scoped `updateMany/deleteMany`, schema validation for professional-fields.

#### Slice F - API, agent, discovery

1. **Domain services for connection / chat / group-join / post-engagement shared by REST, socket and agent** (BR1-BR4, BR9, F5): one place for block checks, trust-tier limits, notifications, activity/streaks, cache invalidation. Closes: agent messaging blockers, joining private/full groups, silent accept; socket bypass of comment limits/blocks. Risk of change High; risk of leaving High.
2. **One `discoverableUsersWhere(viewer, channel)` + block rule** (BR5, BR6, F3, F4): ends 4 definitions of "who is visible" and the agent `shareLocationPublic` leak.
3. **Agent tool-runner** (F2, E1, I6) shared by fallback, Gemini loop and realtime voice; fixes `blockedAction` misclassification in fallback mode. Risk Med.
4. **Recommendation constants + candidate builder** (BR7, BR8, E6, F8): one `DEFAULT_FEATURE_PRIORS`, one `FEATURE_NAMES`, one feedback-exclusion rule for all surfaces. Risk Med-High; run shadow comparison first.
5. **Unified AI client/entitlement layer** (F6, F7, BR11, BR12, I6): `getOpenAIClient(profile)`, env resolver honoring `AI_API_KEY`/baseURL everywhere (embeddings and realtime included), single free-tier quota gate.
6. **Route-level cleanup** (E4, E5, F1, I3, BR10): export `mediaWriteLimit` once (decide shared vs per-surface bucket), deprecate alias routes, uniform `validateMultipartFields`, dedicated limiters for `/reports`, `/premium/boosts/profile`, public discovery, host allow-list on `/users/me/avatar|banner`.
7. **Error/response envelope helper** (I1) with backward-compatible `error` key; align errorHandler/notFoundHandler.
8. **Split index.ts** along the listed boundaries and remove `@ts-nocheck` progressively.



## Risks

- **Static analysis only.** Nothing here was run. The behavioral differences listed are from reading code and may be affected by DB triggers, middleware order or client behavior that the analyst did not see.
- **Merging "same-looking" code can change behavior.** Many duplicates differ intentionally or accidentally in block handling, limits, case sensitivity, caching and error text. Consolidating without a decision on which variant is authoritative will either loosen or tighten access for some entry point.
- **Several gaps are security/privacy relevant** (agent send-request bypass, talk preview exposing raw location, Google OAuth suspended users, reel mass assignment, reel feed block gaps). They are worth triaging independently of the refactor.
- **API contract.** Four different error-response shapes exist and clients may depend on them. Any unification must preserve the `error` key and status codes.
- **Time-based and counter logic is user-visible.** Streak/date-window changes alter user data semantics and need a product decision.
- **Uncommitted work.** The working tree contained about 59 modified files plus new untracked files (for example `src/services/feed/`, `auth-gate.service.ts`) before this phase, so line numbers cited in the slice reports may drift as that work lands.
- **Dead-code overlap.** Some findings concern code the previous audit marked "probably dead" (for example `generateToken`, `enqueueOutboxEvents`, `refundUndeliveredPlatformFailure`, `validatePromptSafeText`). Decide whether those are unwired intended implementations before consolidating around them.
- **Not read in depth:** `matching-engine.service.ts`, `agent/pending-actions.service.ts`, `agent/goals.service.ts`, parts of `people.controller.ts`.
