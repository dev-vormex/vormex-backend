# Vormex Unified Recommendation Platform

## Runtime ownership

The backend owns candidate retrieval, feature imputation, scoring, diversity, exploration, module placement, Premium Boost placement, and stable pagination. Android must preserve the returned order. It may remove duplicate or malformed rows and reuse a cached server response while offline, but it must not compute a replacement rank.

All personalized responses can include `recommendationSessionId`, `requestId`, `rankerVersion`, `experimentVariant`, and `nextCursor`. Ranked items include their canonical `position`, source, explanation, boost state, and privacy-filtered social actors. Home also includes `modulePlacements`.

Recommendation sessions are immutable 30-minute snapshots. Redis is an acceleration layer; PostgreSQL retains the snapshot for seven days and is the authoritative fallback for paging and delayed telemetry. Cursors are HMAC-signed and bound to the viewer, surface, snapshot timestamp, ranker version, variant, and offset.

## Rollout flags

All new behavior is disabled independently by default:

- `RECOMMENDATION_EVENTS_ENABLED`
- `RECOMMENDATION_SEMANTIC_ENABLED`
- `RECOMMENDATION_POSITION_EXPLORATION_ENABLED`
- `RECOMMENDATION_SHADOW_MODEL_ENABLED`
- `RECOMMENDATION_TREATMENT_ENABLED`
- `PREMIUM_POST_BOOST_ENABLED`

`RECOMMENDATION_TREATMENT_SHARE` controls product experiment allocation. `RECOMMENDATION_POSITION_EXPLORATION_SHARE` controls the separate propensity-estimation cohort, which must remain excluded from product experiments. `RECOMMENDATION_CURSOR_SECRET` must be a rotated deployment secret, not the development fallback.

Named activity remains aggregate-only unless `NAMED_ACTIVITY_RECOMMENDATIONS_LEGAL_BASIS_APPROVED=true`. Enabling that flag is an operational legal-policy decision. Per-user activity sharing must also be enabled; only public reactions and comments are eligible to be named.

## Data flow

1. Candidate adapters retrieve at most 500 eligible items from network, network-engaged, semantic, cohort/trending, and exploration sources.
2. Missing feature values use the active model's versioned surface priors. Weights are never renormalized.
3. The engine applies safety and feedback exclusions, the Bayesian negative-rate floor, seven-day repeat suppression, source backfill, and author/network/exploration constraints.
4. Eligible learned heads contribute prior-backed predictions. Active ranking blends 70% learned utility with 30% heuristic utility; hard constraints remain outside the model.
5. The exact ranked IDs, reasons, placements, model, and experiment metadata are persisted before the response is returned.
6. Android records qualified viewport events in a Room outbox. Event ingestion resolves canonical position, boost state, model, and variant from the persisted snapshot rather than trusting client claims.
7. Nightly aggregation, cascade evaluation, embedding work, and independent logistic-head training run asynchronously. No OpenAI call occurs in a ranking request.

## Exposure and privacy rules

- Cards qualify at 50% continuous visibility for one second.
- Stories qualify after two seconds.
- Reels require 50% visibility and foreground playback of `max(3 seconds, 25% of duration)`.
- Transactional endpoints remain authoritative for reactions, saves, comments, follows, connections, applications, joins, and reports.
- Boosted exposure is stored separately and is excluded from organic quality statistics, cascade baselines, and model training.
- Messages, emails, exact coordinates, private content/profile fields, and private engagement are not embedded or exposed as social proof.

## Deployment sequence

1. Apply `20260722120000_add_unified_recommendations` with `npm run migrate:deploy` in the normal deployment workflow.
2. Deploy API, worker, and scheduler with all rollout flags off.
3. Enable event collection and verify supported-client coverage and snapshot reconciliation.
4. Run the 14-day A/A pilot, then enable semantic and shadow-model flags.
5. Enable the separate 5% position-exploration cohort.
6. Release the treatment bundle to 5%, then hold one stable user-randomized 50/50 experiment for at least 14 days.
7. Activate a model or expand traffic only after the documented statistical gates and every latency, safety, retention, negative-feedback, and creator-concentration guardrail pass.

Legacy `feed_impressions` is read only as a temporary repeat-view hint. It is not training data and returned API rows are not written as impressions. Retire it only after 14 consecutive days above 95% supported-client coverage and below 5% reconciliation error.

## Operational verification

Before generating Prisma artifacts on Windows, identify any process whose command line points at this backend and holds Prisma's query-engine DLL, then stop only that repository process. Do not terminate unrelated Node or Java processes.

Run:

```powershell
npx prisma validate
npx tsc --noEmit
npm run build
npm test
npm run docs:validate
```

Android verification:

```powershell
.\gradlew.bat :catalog:testDebugUnitTest :catalog:assembleDebug --console=plain
```

The latency gates require a deployed environment with representative graph and content volume: ranking p95 at most 250 ms, personalized endpoint p95 at most 500 ms, error rate below 1%, and stable paging throughout a 30-minute session.

Run the deployment harness for the required session duration with a dedicated test account:

```powershell
$env:RECOMMENDATION_LOAD_BASE_URL='https://staging-api.example'
$env:RECOMMENDATION_LOAD_TOKEN='<test-account-token>'
$env:RECOMMENDATION_LOAD_DURATION_SECONDS='1800'
$env:RECOMMENDATION_LOAD_CONCURRENCY='20'
npm run load:recommendations
```
