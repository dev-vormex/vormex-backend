# Backend architecture and maintenance

The backend is organized by feature ownership, with explicit HTTP, realtime, infrastructure, and process composition. The October 2026 reorganization preserves existing implementations, endpoint paths, middleware order, socket events, environment defaults, jobs, and npm/deployment entry points.

## Where code belongs

```text
src/
  api.ts, index.ts                    Stable API entry points
  worker.ts, scheduler.ts             Stable background-process entry points
  proximity-worker.ts,
  proximity-scheduler.ts              Stable dedicated proximity entry points
  bootstrap/                          API startup/shutdown and process supervision
  config/                             Runtime configuration and Prisma clients
  http/                               Middleware, route mounting, operations, docs, MCP
  realtime/                           Socket setup, per-server state, event registration
    handlers/                         Agent, posts, chat, groups, reels, stories, location, arcade
  modules/<domain>/                   Feature-owned implementations
    routes/                           HTTP routes and route-local middleware
    controllers/                      HTTP validation, responses, service orchestration
    services/                         Business operations and feature persistence
    utils/, types/, data/, constants/ Domain-owned supporting code where needed
  infrastructure/                     Redis, queues, outbox, metrics, logging, provider adapters
  jobs/                               Worker processors, scheduler definitions, maintenance dispatch
  shared/                             Reused middleware, access helpers, utilities, types
  scripts/                            TypeScript operational/backfill tools
  tests/                              Backend tests, source safety checks, contract fixture
  openapi.yaml                         Existing API specification
prisma/                               Schema and migrations
scripts/                              Build, dev-launcher, verification, and operational tooling
```

### Feature ownership

| Module | Responsibility |
| --- | --- |
| `auth` | Registration, login, OAuth, verification, sessions, devices, onboarding |
| `profiles` | Profiles, professional fields, social proof, profile analytics |
| `connections` | Connection/follow operations and relationship side effects |
| `chat` | Conversations, messages, delivery, read receipts |
| `groups` | Groups and circles |
| `content` | Posts, reels, stories, audio, uploads, saved content, mentions |
| `discovery` | People, matching, feeds, recommendations, public discovery |
| `proximity` | Location, presence, Crossed Paths sessions/history/privacy |
| `engagement` | Activity, progress, rewards, streaks, challenges, accountability |
| `games` | Games and arcade rooms |
| `opportunities` | Hackathons, events, learning, jobs, interviews |
| `education` | College communities and institution lookup |
| `premium` | Entitlements, checkout, provider verification, boosts, premium administration |
| `identity` | Identity verification and evidence |
| `safety` | Reports, safety policy, trust checks, tier limits |
| `notifications` | Notification records, push delivery, match/re-engagement campaigns |
| `agent` | Agent APIs, orchestration, tools, sessions, goals, voice support |
| `ai` | AI assistance, chat, talk, and AI rate limits |
| `ads` | Ad delivery and ad administration |
| `admin` | Administration and moderation operations |
| `integrations` | User-facing integration APIs |
| `skills` | Skills and skill-swap APIs |
| `store` | Store APIs |

A module need not contain every subdirectory. Cross-module calls target the owning service, utility, or type directly. Existing shared access helpers and provider adapters retain their established dependencies; this organization does not claim that every historical coupling or circular dependency has been removed.

## Startup and ordering

`src/bootstrap/api.ts` validates configuration, creates the Express/HTTP/Socket.IO instances, starts the existing Redis initialization, creates per-server socket state, registers socket handlers, installs HTTP layers, and enters the existing API lifecycle. Root process entry points remain compatible with the existing npm scripts and Render configuration.

`src/http/app.ts` makes the registration order explicit:

1. `middleware.ts`: logging, metrics, security, size limits, compression, CORS, parsers, raw-body webhook, response-cache policy, and input validation.
2. `operational-routes.ts`: liveness/readiness/health, metrics, and conditional documentation.
3. `routes.ts`: application guards, AI validation, ordered feature mounts, MCP registration, then 404 and error handlers.

The Razorpay webhook retains its original placement ahead of shared input sanitization and authentication. Specialized proximity JSON parsing retains its original size limit and error handling.

`src/realtime/context.ts` owns state shared by sockets on one server. `register-handlers.ts` installs authentication, packet validation, connection setup, domain handlers in their original order, and disconnect cleanup. Each handler file owns an event family. `content-fanout.ts` retains the original socket transaction/fanout implementations. Feature code uses the existing socket registry bridge when it needs the active Socket.IO instance; it does not import server setup.

The worker and scheduler implementations live in `bootstrap/`, while their processors and schedules live in `jobs/`. Their startup, idle behavior, heartbeat, shutdown sequence, and error behavior are unchanged.

## Enforced rules

[AGENTS.md](../../AGENTS.md) is the repository maintenance policy. `scripts/check-architecture.js` verifies local module resolution and prevents:

- Feature/shared/infrastructure dependencies on process startup, HTTP composition, or job composition.
- Lower-layer dependencies on realtime setup and handlers, except the established socket registry bridge.
- Services or infrastructure depending on HTTP controllers/routes.
- HTTP composition depending on process or job implementations.
- Process entry points being imported as application dependencies.

The streak-update operation previously exposed by the engagement controller now belongs to the engagement service, with its date helpers in a domain utility. Its implementation is unchanged.

Import concrete files rather than broad barrels. Configuration, authorization, cache policy, transaction boundaries, and queue semantics are business contracts and must not be changed as a side effect of organization.

## Commands and verification

| Command | Purpose |
| --- | --- |
| `npm run check:architecture` | Check layer boundaries and local dependency resolution |
| `npm run typecheck` | Run TypeScript without emitting output |
| `npm run build` | Generate Prisma, clear generated output, compile, copy OpenAPI |
| `npm test` | Build and run backend and cross-client suites |
| `npm run verify` | Architecture/type-safety policy checks, build, and OpenAPI validation |
| `npm run format` | Apply the configured Prettier style to source and scripts |
| Existing `dev:*`, `start:*` scripts | Unchanged development/deployment process commands |

The build clears generated `dist/` output before compilation so moved modules cannot remain in deployment caches. The organization preserved runtime dependencies; the subsequent quality pass refreshed compatible versions to address dependency advisories. OpenAPI validation and bundling use the local Swagger Parser 12.x dependency through the existing npm commands. Prettier is a development-only dependency; legacy files were not broadly reformatted in this pass.

`src/tests/fixtures/api-contract.json` was captured from the backend before organization. It records 727 nested HTTP layers (including middleware, router layers, route methods, and handler bindings) plus 44 socket events, authentication middleware count, and transport settings. The contract probe loads the real composition in an isolated process, never binds a listener, replaces the startup database query with a pending promise, and uses synthetic credentials. The regression test compares the reorganized composition against that baseline.

Additional one-time verification compared 305 existing implementation files after normalizing import paths, 41 startup helper bodies, and 39 socket callback implementations. No business implementation differences were found. Source-inspection safety tests were pointed at their current implementation locations and retained their safety/ordering assertions.

The full suite has two existing cross-client tests requiring a sibling `vormex-android` checkout. Missing that checkout is an environment dependency, not a passing test. Live database flows and a deployment were not verified during this reorganization. The extracted realtime code is fully typechecked without its previous file-wide suppression; one erased type assertion preserves the original JSON spread operation. The subsequent quality pass enabled strict checking throughout the implementation and removed all file-wide suppressions.

## Finding moved files

[source-map.json](source-map.json) records previous and current source locations. Existing cleanup reports and domain audits describe earlier snapshots; their historical paths have not been rewritten to imply that those analyses were performed against the new layout.

## Focused implementations and shared contracts

The large feature entry modules now provide named compatibility exports. Their adjacent folders own specific capabilities: profile skills, experience, education, projects, certificates and achievements; post publication, feed snapshots, comments and reactions; group invitations, membership, messages and management; administrative moderation and identity review; and notification operations by domain. Routes and existing service consumers keep their established import paths.

The agent tool dispatcher selects explicit tool handlers. Shared schemas, search helpers, prompt context and action policy have separate owners. Agent services retain ownership of provider configuration and session state; extracted operations use internal typed execution contracts. Collaborator getters resolve the current service method, preserving instance binding and allowing existing collaborator overrides.

Identical helpers have one owner for environment parsing, Retry-After headers, agent conversation memory, profile field normalization, group slugs, conversation pairs, billing notes/cycles, discovery scoring, feed token normalization, and content value parsing. The 26 identical minimal authenticated-request interfaces share one type. Helpers with different behavior remain distinct, including rounding versus flooring positive environment values.

`npm run check:architecture` now enforces a 600-line limit on all TypeScript/JavaScript source files, tests and operational scripts, and detects runtime cycles among refactored modules. Aim for 200–400 lines per responsibility. OpenAPI documents and JSON fixtures are declarative data and do not count as implementation files.

`refactor-map.json` maps stable entry modules to live declarations. Source-inspection tests use that map to inspect moved implementations in their original declaration order; import assertions inspect actual bindings independently of formatting. This map is verification metadata, not a runtime application dependency.

## Type safety and test execution

TypeScript strict checking, including implicit-any and null checks, is enabled throughout the implementation. `type-safety-debt.json` is empty. `npm run check:typesafety` rejects new unchecked files, silent `@ts-ignore` directives, disabled constituent strict checks, undocumented expected errors, and stale debt entries.

The authorized quality pass corrected malformed chat/reward validation, validated required project dates before persistence, repaired Prisma relation selections while retaining public response aliases, and restored mutable state updates through the lifecycle owner. Behavioral regression tests cover these paths. The runtime route, middleware, and Socket.IO fixture remains unchanged.

Outbox processing claims recover after `OUTBOX_PROCESSING_LEASE_MS` (default five minutes, minimum thirty seconds). Completion, retry, and terminal updates require the current claim timestamp, so an older dispatcher cannot overwrite a newer claim. Existing queue payloads, stable job IDs, retry delays, and age-based delivery rules are retained. Delivery remains at least once; these offline tests do not establish live database or queue readiness.

Backend CI runs `npm run verify` followed by `npm run test:backend:compiled`, so the compiled backend suite runs against the same build that was verified. For local use:

- `npm run test:backend` builds and runs the standalone backend suite.
- `npm run test:clients` builds and runs the Android contract checks under `src/tests/cross-client/`. It requires a sibling `../vormex-android` checkout and fails when that dependency is missing.
- `npm test` builds and runs both suites. Missing Android sources remain failures in this complete verification command.

The existing Android assertions are retained in the cross-client suite. Backend CI does not claim to verify the Android checkout. Passing these offline checks does not establish live database, provider, or deployment readiness.
