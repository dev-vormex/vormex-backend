# Visibility and Safety Domain

Status: first consolidation phase. Policy is centralised for the entry points listed in section 6; the remaining gaps are in section 9.

## 1. Domain concepts

Six questions are kept separate on purpose. A user can be allowed to *see* someone but not *message* them, or see a public profile but not send a request.

| Question | Policy function | Denial reasons | Typical callers |
|---|---|---|---|
| May this **account** perform operations at all? | `evaluateAccountMayAct` / `assertAccountMayAct` | `ACCOUNT_BANNED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_RESTRICTED` | actions without a target user |
| May **actor interact** with **target** (message, request, comment, react, endorse)? | `evaluateInteraction` / `assertUsersCanInteract` | the above + `TARGET_UNAVAILABLE`, `BLOCKED` | REST writes, socket writes, agent tools |
| May **viewer see** target's profile/content? | `evaluateProfileVisibility` / `assertCanViewUser` | `TARGET_UNAVAILABLE`, `BLOCKED` | profile previews, passports, mutual info |
| May a user **appear in discovery** for the viewer? | `evaluateDiscoveryCandidate` / `discoverableUsersWhere` / `getDiscoverableUsersWhere` | `TARGET_UNAVAILABLE`, `BLOCKED`, self | search, suggestions, nearby, contacts, agent search |
| Should **recipient be notified** of actor's action? | `evaluateNotificationRecipient` / `shouldNotifyUser` | `BLOCKED`, `SELF_NOTIFICATION` | in-app + push notifications, mentions |
| May viewer see target's **location**? | `evaluateLocationVisibility` | boolean | profile/talk/agent location fields |

Trust-tier rate limits (`enforceTrustTierLimit(userId, action)`) are a separate **quota** concern, not a visibility rule. They stay in `trust-safety.service.ts`. "Trust tier restricted" in the account sense (`safetyRestrictedUntil`) is handled by `evaluateAccountMayAct`.

## 2. Rules

Derived from the existing `assertUsersCanInteract` and the Prisma schema (`User.isBanned`, `safetySuspendedUntil`, `safetyRestrictedUntil`, `shareLocationPublic`; `user_blocks`, `user_block_device_scopes`, `user_devices`).

- **Ban:** `isBanned = true`, permanent until cleared.
- **Suspension:** active while `safetySuspendedUntil` is strictly in the future. An expired or equal timestamp means not suspended.
- **Restriction:** active while `safetyRestrictedUntil` is in the future. It blocks social actions only; it does not hide the account and does not stop viewing.
- **Block:** exists when a `user_blocks` row exists in either direction, or a device-scoped block links the two accounts via install hashes. It is direction-agnostic for every question above.
- **Interaction order (part of the contract, decides which reason is shown):** actor banned, actor suspended, actor restricted, target unavailable (banned or suspended), blocked. A target's unavailability outranks a block so a block is not revealed.
- **Self:** acting on or viewing yourself is never denied by these rules. Self is excluded from discovery and from notifications.
- **Viewing:** denied for a banned/suspended target and for blocked pairs. Restriction of the viewer does not hide content.
- **Location:** visible when viewer is the owner or `shareLocationPublic === true` (the pre-existing rule in `profile.service.ts`).
- **Missing account record:** imposes no restriction (historic behavior preserved).

## 3. Authoritative implementation

```
safety-policy.ts            pure decisions; no I/O, no transport, no imports
        ^
trust-safety.service.ts     loads facts (Prisma + cache), maps decisions to SafetyActionError
        ^
entry points                REST controllers, Socket.IO handlers (src/index.ts), agent tools, jobs
```

- `src/services/safety-policy.ts` returns `{ allowed: boolean, reason?: SafetyDenialReason }`. It never knows about HTTP.
- `src/services/trust-safety.service.ts` stays the single data and enforcement layer:
  - `getBlockedUserIds`, `findBlockBetween`, `areUsersBlocked`: block facts.
  - `assertUsersCanInteract` (now implemented with `evaluateInteraction`, identical codes/messages/statuses), `assertAccountMayAct`, `assertCanViewUser`, `shouldNotifyUser`, `getDiscoverableUsersWhere`.
  - `safetyDenialToError`: the only place a policy reason is mapped to `SafetyActionError` (`account_banned`, `account_suspended`, `safety_restricted`, `target_unavailable` 404, `user_blocked`).
  - `safetyErrorResponse`: unchanged `SafetyActionError` to `{statusCode, body}` for REST/socket callers.
- No repository layer was introduced. Prisma access stays inside `trust-safety.service.ts` where it already lived; the policy/data split is the module boundary above.

## 4. Data dependencies

| Fact | Source |
|---|---|
| ban / suspension / restriction | `User.isBanned`, `safetySuspendedUntil`, `safetyRestrictedUntil` |
| block (explicit) | `user_blocks (blockerId, blockedId)` |
| block (device-scoped) | `user_block_device_scopes` joined to `user_devices.installHash` |
| trust tier | `User.identityTrustLevel` |
| location opt-in | `User.shareLocationPublic` |

## 5. Cache dependencies

- `getBlockedUserIds`: cacheService key `safety:blocked-users:v1:user:<id>`, TTL 60s, tag `safety:blocked:<id>`. Invalidated by `invalidateBlockedUserIdsCache` on block/unblock (also invalidates feed, stories, reels, chat, profile, people, matching, notification and relationship tags).
- `assertUsersCanMessageCached`: in-process 5s memo per actor/target pair (`invalidateMessageInteractionCache`).
- Trust level: 30s in-process memo. Trust-tier counters: Redis rate limiter.
- Consequence: a block takes up to 60s to reach list filters unless the invalidation path runs; point checks (`areUsersBlocked`, `assertUsersCanInteract`) are uncached.
- Talk profile preview cache: now stores a viewer-independent body with `location: null` under `v2` keys; the lookup cache stores only the resolved id. Safety checks and location gating run on every request.

## 6. Entry points on the shared rules (this phase)

| Entry point | Change |
|---|---|
| Agent `chat_open_conversation`, `chat_send_message` | `assertUsersCanInteract` + `enforceTrustTierLimit('dm')` before writing |
| Agent `connections_send_request` / `connections_accept_request` | target existence, interaction check, `connection_request` trust limit |
| Agent `groups_join` | rejects private and full groups (REST `joinGroup` parity) |
| Agent `people_search`, `matching_find_like_minded_peers`, `profile_get_user` | discoverable filter (blocked/banned/suspended); `profile_get_user` returns not-found for hidden targets |
| Agent location | location and nearby-distance only for owner or `shareLocationPublic` users |
| Agent `posts_create_text` | `enforceTrustTierLimit('post')` |
| Socket `post:comment` | `enforceTrustTierLimit('comment')`, parent-comment-author interaction check, structured safety errors |
| Socket `comment:like` | comment-author interaction check, structured safety errors |
| Socket presence and `location:update` | blocked users removed from recipients (rooms and `.except`) |
| Talk people search | discoverable filter |
| Talk profile preview | per-request `assertCanViewUser`; location gated by `shareLocationPublic`; viewer-independent cache |
| People-you-know (read and sync time) | self/banned/suspended/blocked excluded |
| Skills | passport block 404, endorser filter, suggestions filter, interaction checks on endorse/request/accept |
| Follow `getMutualInfo`, `getFollowCounts` | block 404 and mutual-set filtering |
| Location nearby SQL, discovery-power nearby, `buildPeopleDiscoveryWhere` (incl. saved-search matches) | blocked and suspended excluded in SQL |
| Recommendation learning cascade | device-scoped blocks included |
| Reels feed / trending | blocked authors excluded for authenticated viewers (no shared cache for authed users) |
| Reels hashtag/audio/user lists | unpublished (scheduled) reels no longer exposed |
| Reel comments, comment likes | trust limit + interaction checks; mention notifications require `canViewReel` and `shouldNotifyUser` |
| Notifications (13 user-actor sites) | push skipped when the in-app notification was suppressed (self/blocked) |
| Google sign-in | active `safetySuspendedUntil` rejected like password login |
| Admin `takeReportAction` | ban/restrict now invalidate proximity like the direct admin paths |

## 7. Decision / result types

```ts
type SafetyDenialReason =
  | 'ACCOUNT_BANNED' | 'ACCOUNT_SUSPENDED' | 'ACCOUNT_RESTRICTED'
  | 'TARGET_UNAVAILABLE' | 'BLOCKED' | 'SELF_NOTIFICATION';
interface SafetyDecision { allowed: boolean; reason?: SafetyDenialReason } // reason set when allowed is false
```

A decision is never an HTTP response. Transport adapters:
- REST: catch `SafetyActionError`, use `safetyErrorResponse`; for hidden resources use 404 `{ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false }`.
- Socket: `socket.emit('error', safety.body)` (as `chat:send_message` already did).
- Agent: `safetyToolFailure` maps `SafetyActionError` to the existing blocked-tool result shape.

## 8. Security and privacy considerations

- Hidden and blocked targets are presented identically (404 / "not found") so a block cannot be probed.
- Location: the talk preview previously returned the raw `location` string for any viewer, cached per target. It is now returned only to the owner or when `shareLocationPublic === true`. Field name and string shape are unchanged; a switch to the coarse DTO (`serializeCoarseLocation`) is a client-contract decision left open. The agent no longer leaks location or a distance oracle for users who have not opted in.
- `profileRing` in the talk preview is unchanged. No privacy rule was found for it; it is ambiguous (see section 9).
- Reel upload: `onUploadComplete` spread the raw request body into `prisma.reels.create`, which could override `authorId`, `status`, counters and more. It now accepts an allowlist (`pickReelUploadMetadata`). `saveAsDraft` is no longer forwarded to Prisma (it is not a column).

## 9. Known inconsistencies still open

- **Auth domain (deferred):** "email not verified" uses multiple codes; refresh revokes sessions on suspension while login and Google do not; auth-gate caches denials (possible stale window after a suspension expires, unverified); Socket.IO checks ban/suspension only at handshake, so a mid-session ban is not enforced until reconnect.
- Agent `chat_send_message` still writes `messages` directly rather than going through `sendChatMessage` (no realtime emit, push, idempotency); `already_connected_or_pending` differs from REST re-send semantics.
- Group messaging (REST `sendGroupMessage` and socket `group:message`): no interaction/trust checks and no block filtering of recipients (parity gap on both sides, not changed).
- Reel/post `votePoll`, post likes: no actor ban/suspension re-check (parity with REST).
- `getFollowCounts`, `getFollowers`, `getFollowing`: counts and lists still include banned/suspended users; `getFollowCounts` has no auth.
- Skill-swap internals (`hydrateSkillSwapRows`, `getSkillSwapState`, `completeSkillSwapSession`) and existing pending requests with a later-blocked user are unfiltered.
- Several controllers still implement their own block filters (`people.controller`, `matching.controller`, feed) instead of `getDiscoverableUsersWhere`; they are consistent in effect but not yet migrated.
- Four different error-response shapes remain across controllers; the new checks reuse the neighboring shape.
- Block cache staleness up to 60s for list filters.
- `recommendation-learning` keeps its raw `user_blocks` SQL clauses as defense-in-depth beside the shared block set.
- Mutual-connection set logic has several variants (see duplication audit).

## 10. Tests

- `src/tests/safety-policy.test.ts`: pure rule matrix (normal, blocked both directions, self, banned, suspended, expired suspension, restricted, target unavailable, missing records, viewing vs interacting, discovery fragment, notification suppression, location rule, error-code mapping, transport-free module).
- Entry-point wiring tests (source-inspection, repo convention): `safety-agent-tools`, `safety-socket-handlers`, `safety-discovery-controllers`, `safety-nearby-reels` (plus two behavioral tests for `pickReelUploadMetadata`), `safety-notifications-auth-admin`.
- Limitation: wiring tests assert that the shared helpers are called in the right places; they do not exercise a database. No live-DB validation was performed.

## 11. Future integration points

- Move remaining controllers' block filters to `getDiscoverableUsersWhere`.
- Route agent chat through `sendChatMessage`.
- Auth-domain phase: shared account-state gate for login, refresh, OAuth and sockets; socket disconnect on ban/suspend.
- Notification delivery gate for in-app + push using `shouldNotifyUser`.
- Group messaging and poll/like actor-state checks.
- Decide location DTO and `profileRing` privacy.
- Background jobs (digests, saved searches, recommendation) should use `getDiscoverableUsersWhere`.
