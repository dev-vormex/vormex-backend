# Backend maintenance rules

## Preserve contracts

- Preserve routes, middleware order, status codes, response shapes, socket event names, authorization checks, and side effects unless the user explicitly authorizes a behavior change.
- For organizational refactors, move implementations without rewriting business rules. Preserve environment defaults, transaction boundaries, cache keys, timing, queue names, and shutdown order.
- Do not remove manual operational tools or database migrations just because the application does not import them.
- Preserve existing working-tree changes. Never reset the repository to make a refactor easier.

## Ownership and dependencies

- `src/bootstrap/` composes and supervises processes. Root `api.ts`, `index.ts`, worker and scheduler files are stable entry points for npm and deployments.
- `src/http/` owns middleware order, operational endpoints, API mounting, documentation, and MCP HTTP integration.
- `src/realtime/` owns Socket.IO setup, per-server state, and domain event registration. Keep event registration order explicit.
- `src/modules/<domain>/` owns feature routes, controllers, services, utilities, and types. Keep HTTP handling in controllers and business operations in services.
- `src/infrastructure/` owns adapters for persistence, Redis, queues, outbox delivery, metrics, logging, email, media, and external HTTP.
- `src/shared/` holds reused middleware, access helpers, utilities, and types. Existing cross-domain access helpers remain here; do not duplicate their rules.
- `src/jobs/` owns worker processors, scheduler registration, and maintenance dispatch.
- `src/config/` owns runtime configuration and database clients. `prisma/` is the database model and migration authority.
- Import specific modules explicitly. Avoid broad barrels that hide initialization, dependencies, or circular imports.
- Services and infrastructure must not import controllers or route modules. Lower layers must not import process entry points, bootstrap code, HTTP composition, job composition, or realtime handlers. The socket registry is the existing compatibility bridge for Socket.IO emitters.
- Cross-domain dependencies must be explicit and directed to the owning service, utility, or type. Do not introduce a new abstraction solely to move a file.

## Verification

- Run `npm run check:architecture`, `npm run typecheck`, and relevant tests for structural changes. `npm test` builds and runs the backend suite.
- The API contract fixture captures the pre-organization runtime routes, ordered middleware, handler bindings, and Socket.IO events. Change it only alongside an explicitly authorized contract change.
- Source-inspection tests must read the current implementation location and retain their safety assertions when code moves.
- Format new composition code with Prettier and preserve literal contents. Do not combine broad formatting changes with behavior changes.
- Some cross-client tests require a sibling `vormex-android` checkout. Report missing dependencies; do not hide those failures or manufacture a passing result.
- A clean build and passing offline contracts do not establish live database or deployment readiness. Report what was actually verified.

## Keep responsibilities small

- Aim for focused modules around 200–400 lines. `npm run check:architecture` enforces a 600-line ceiling for TypeScript and JavaScript source, tests, and operational scripts. Declarative OpenAPI documents and JSON fixtures are separate data contracts.
- Split by capability (for example, education, projects, chat requests, notification delivery), not by arbitrary line ranges. A stable import facade may re-export named public functions while implementations have specific owners.
- Shared code must preserve the complete input/default/error contract. Similar helpers can intentionally differ: flooring versus rounding, case-preserving strings versus normalized profile fields, and prefix parsing versus strict numeric validation.
- Keep mutable bindings with their writers and service state with its lifecycle owner. Extracted operations receive narrow typed execution contracts; they must preserve dynamic collaborator lookup, authorization order, transactions, and error propagation.
- Refactored implementation modules must have no runtime dependency cycles. Type-only dependencies are allowed; the architecture checker erases those imports before checking cycles.
- `docs/architecture/refactor-map.json` records live declaration locations for source-inspection tests. Update it when an implementation moves; keep assertions pointed at current code, never copied implementation snapshots.
