# C02 activation fix1 report

Status: 59 product files frozen for root re-review and clean acceptance. No commit, push, deployment, live configuration, paid inference, or subagents. C02 is not marked complete.

## Resolved review I1: delayed acquisition

An automatic caller could observe an absent or stale catalog, pause before `tryAcquire`, and then discover again after another coordinator had published a fresh snapshot. The redundant discovery could fail and make the caller unavailable despite that accepted snapshot.

`CatalogObservation.publicationVersion` now exposes the raw SQL publication counter, independently of snapshot validity or generation. It is zero when no catalog row exists. `tryAcquire` accepts optional validated `expectedPublicationVersion`; its SQL UPDATE checks it atomically alongside identity, lease, and backoff predicates. Automatic/background readers pass the observed counter. Losing the CAS makes them re-read authority and use the accepted snapshot. Explicit refresh omits this optional CAS and keeps its intentional refresh behavior. No new migration is required.

Real independent-handle SQLite regressions pause B before acquisition, let A publish, then resume B. Cold, cold-with-failing-redundant-discovery, and stale-background cases require one discovery and one new publication. The explicit case intentionally requires two. The strengthened malformed-snapshot test also proves a null accepted snapshot can report raw version 1, reject expected version 0, and repair by acquiring version 1 and publishing version 2.

## Resolved full-suite fixture failures

Root's clean CI log `/tmp/vnext-c02-activation-clean-ci.log` had 4320 pass / 1 skip / 190 fail. First-error investigation traced the 503s across 34 route/e2e files to legacy fixtures exposing only `upstreams.list`, without SQL catalogs or stored identities.

These tests now explicitly import `tests/helpers/catalog-test-repo.ts`. It preserves source filters, mutations, and capture spies, mirrors source rows into a migrated in-memory `BunSqliteRepo`, and delegates catalog operations to the actual SQL repository. Source edits synchronize before catalog operations; unchanged source rows never overwrite credentials rotated in SQL. It supplies real incarnation/generation and SQL proxy/catalog storage. No production fallback or fabricated catalog-success path was added. Four owner-scoped source fixtures now include their intended ownerId.

Copilot fetch fixtures explicitly return a synthetic stored-account token exchange where needed; request tokens are never written into persisted discovery. Two Responses test files had incomplete model-list responses missing `object: "list"`; their network fixtures were corrected. Existing assertions were retained; the malformed-snapshot test gained assertions.

The first adapted 34-file run had 235 pass / 43 fail. Those 43 failures isolated the incomplete Responses model lists; the corrected two-file run passed all 47 tests. Both logs are retained.

## Verification

Commands ran from `vnext`. No full `ci:local` was run by this writer. Root owns clean CI, independent review, actual workerd/D1, two-isolate HTTP, and integration.

- RED: `bun test packages/gateway/tests/catalog-coordinator.sqlite.test.ts --test-name-pattern 'a delayed'` — 2 pass / 3 fail / 12 filtered / 13 assertions. `task-C02-activation-fix1-race-red.log`.
- Final race/repository: `bun test packages/gateway/tests/catalog-repo.sqlite.test.ts packages/gateway/tests/catalog-coordinator.sqlite.test.ts` — **45 pass / 0 fail / 1223 assertions**. `task-C02-activation-fix1-race-final.log`. Includes the additional malformed-snapshot counter assertions.
- First repaired fixture: `bun test packages/gateway/tests/data-plane-models-embeddings-images.test.ts` — **19 pass / 0 fail / 38 assertions**. `task-C02-activation-fix1-first-fixture.log`.
- Original failing files: Python invoked `subprocess.run(["bun", "test", *json.loads(Path("../.superpowers/sdd/2026-09-29-reference-adoption-follow-up/task-C02-activation-fix1-failing-files.json").read_text())])` — historical **235 pass / 43 fail / 896 assertions**. `task-C02-activation-fix1-fixtures.log` preserves the failure.
- Corrected Responses fixtures: `bun test packages/gateway/tests/responses-snapshot-id-roundtrip.test.ts packages/gateway/tests/responses-previous-id.e2e.test.ts` — **47 pass / 0 fail / 233 assertions**. `task-C02-activation-fix1-responses-fixtures.log`.
- Complete local suite: `bun test` — **4560 pass / 1 skip / 0 fail / 82233 assertions across 449 files**, exit 0, 40.95 seconds. `task-C02-activation-fix1-full-tests.log`. This includes unchanged protected user work and is not a clean-verify CI claim. Afterwards only three additional malformed-snapshot assertions and an explanatory coordinator comment were added; final focused tests, typechecks, and lint cover final bytes.
- `bun run --filter @vibe-llm/gateway --filter @vibe-llm/platform-bun --filter @vibe-llm/platform-cloudflare --filter @vibe-core/http typecheck` — all four exit 0 on final bytes. `task-C02-activation-fix1-typecheck-final.log`. Earlier helper-type errors remain in `task-C02-activation-fix1-typecheck.log`.
- Installed vnext ESLint on every owned `.ts` path — **0 errors / 4 pre-existing warnings**, exit 0. `task-C02-activation-fix1-lint.log`. Three unused test symbols in newly owned fixtures join the existing HTTP preserve-caught-error warning.
- `git diff --check -- <59 owned paths>` passed. All 10 protected hashes match; the four preexisting unrelated untracked product files match the baseline manifest. No protected path overlaps ownership. Root runtime/evidence files were not edited.

## Frozen handoff

- `task-C02-activation-owned.json`: full 59-path scope.
- `task-C02-activation-frozen-sha256.json`: exact current bytes.
- `task-C02-activation-fix1-owned.json`: 40 changed/added paths relative to initial freeze (5 existing paths plus 35 fixture/helper paths).
- `task-C02-activation-fix1-failing-files.json`: exact original 34-file fixture batch.
- `task-C02-activation-report.md`: updated overall report; earlier focused/runtime evidence is historical.

The original cancellation, bounded terminal evidence, authorization lease, opt-in cleanup, and SQL-operation lifetime boundaries remain. Root's prior runtime results and newly reported actual-D1 race RED evidence are historical; this freeze requires root reruns. Product writes stop after this freeze.
