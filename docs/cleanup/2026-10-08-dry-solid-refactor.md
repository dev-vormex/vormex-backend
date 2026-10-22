# DRY and responsibility refactor

The refactor preserves existing HTTP endpoints, Socket.IO events, response handling, authorization checks and business operations. It changes ownership and composition without changing query logic, transactions, cache keys, queue names or environment defaults.

- Large controllers are split into capability modules, including profile sections, content publication/comments/reactions, chat requests/read state, group invitations/membership, and administrative moderation.
- Notification, social-proof and agent service operations have focused implementation modules. Service instances retain their state and lifecycle. Agent operations use explicit typed execution contracts with dynamic collaborator lookup.
- All 16 agent tool branches have separate handlers selected by the existing dispatcher. The current-user lookup and unsupported-tool response remain in their original execution order.
- Duplicate helpers share domain or infrastructure owners. Identical minimal authenticated-request interfaces now use one shared type. Flooring, rounding and integer-prefix parsing remain separate contracts.
- Operational seed entry points remain stable. Seed catalogs and implementation helpers are extracted without executing seed operations.
- Every TypeScript and JavaScript implementation, test and operational script is below 600 lines. Architecture checks enforce the ceiling, existing dependency directions, import resolution, and absence of runtime cycles among refactored modules.
- Source-inspection tests inspect live implementation locations through the declaration map. Existing safety assertions remain; import checks now inspect bindings rather than whitespace or folder depth. Feed ranking tests are split by responsibility while retaining their flat npm/CI entry point.

Verification includes a build, type checking, architecture checks, OpenAPI validation, and the complete backend suite. The unchanged contract fixture verifies 727 HTTP layers and 44 socket events. An AST comparison against the pre-refactor workspace verified 812 function bodies, 115 class method bodies, 16 tool branch bodies, and 3,456 body/default/state comparisons. Four focused regression tests cover distinct shared-helper contracts and service delegation, including instance binding, dynamic collaborators, response shape, optional speech synthesis and error propagation.

The two existing cross-client tests need the missing sibling `vormex-android` checkout. Offline verification does not establish live database or deployment readiness. Legacy TypeScript suppression directives in moved implementations remain inherited from their original code; this refactor does not claim a complete strict-typing migration.

Final results: `npm run verify` and `npm run typecheck` passed. The complete suite ran 448 tests: 446 passed and the same two missing-Android tests failed. The runtime HTTP/Socket.IO contract test passed. `npm start` was retried and exited because Prisma could not reach the configured Neon database; the backend is not running.
