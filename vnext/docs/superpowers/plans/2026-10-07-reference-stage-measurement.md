# Reference stage measurement implementation plan

> **For agentic workers:** Use executing-plans for the coordinated runner and delegate independent adapters. Track each delivered item separately.

**Goal:** Produce a reproducible local three-arm comparison that separates user latency, process resources, source-level stage work and different diagnostic contracts.

**Architecture:** Extend the existing comparison tooling in a new dated harness. Keep original product source and evidence unchanged; use exact build-time hooks only in diagnostic bundles. Reuse strict supervision, Inspector identity and physical readback where their contracts match.

**Tech stack:** Existing Bun 1.3.0, Miniflare 4.20260601.0 and workerd 1.20260601.1; real local D1/R2/KV; Darwin libproc for process resource counters.

**Spec:** `../research/2026-10-07-reference-stage-measurement/README.md`.

## Constraints and implementation findings

- Use the existing `fix/cfw-resource-rollback` worktree; baseline/reference source and all unrelated MAIN changes remain unchanged. Deliver only the new measurement docs/tools to local vNext.
- Preserve dirty files using the new raw directory's `main-protected.json` and `repair-protected.json`; never rewrite earlier evidence.
- No production access, deployment, push, existing-service restart, or worktree cleanup.
- New tools live in `research/2026-10-07-reference-stage-measurement/harness`; initial raw output lives in `.superpowers/sdd/2026-10-07-reference-stage-measurement`, and October 8 recovery/qualification/pilot evidence lives in `.superpowers/sdd/2026-10-08-reference-workerd`.
- Preserve all dispatch, stream demand/cancel, diagnostic content and settlement behavior. Sampling, clocks and CPU scopes must retain their limitations.
- Reference feasibility inspection found installed dependencies missing or different from its pnpm lock. The initial no-install assumption cannot produce a valid R artifact. Prepare a Git archive in the new owned raw directory and install only there using its frozen lock and `--ignore-scripts`. Record the package manager identity, lock/patch identities and installation outcome. Do not mutate either project's installed dependencies or substitute B versions. This is an isolated measurement prerequisite, not a product dependency change.
- The reference Worker requires its real exported `ExecutionDO` and `EXECUTION_DO` binding; bind these even when the chosen HTTP fixture does not use native WS.

## Task 1: Reference artifact and persistence adapter

Files: `harness/reference-adapter.ts`, `harness/reference-adapter.test.ts`; a separate readback module if needed.

Interface: `buildReference(root, out, options?)` returns bundle, migration root, consumed original file identities and transformation receipts. `seedReference(db, {referenceRoot, baseUrl, apiKey, fixtureSecret, dump, model})` inserts a synthetic owner/key and one static custom Chat model. `readReferenceStorage` reports the reference schema and decoded physical objects; it must not pretend to use B's sidecar schema.

- [x] Verify declared import/lock identity, source containment and missing-dependency rejection before accepting a bundle.
- [x] Test real schema seeding and malformed descriptor/object failure behavior before implementation acceptance.
- [x] Build the real Cloudflare entrypoint with existing Bun options; freeze all consumed source/dependency files and original-to-transformed hashes.
- [x] Retain build/installation failures as evidence and validate archived source/lock/patch equality with R.

## Task 2: Local resource and stage observers

Files: `harness/process-resources.ts`, `process-resource-probe.py`, `process-resources.test.ts`, `instrumentation.ts`, `instrumentation.test.ts`.

Interfaces: `readProcessResource(pid)` supplies process identity, cumulative user/system microseconds and instantaneous RSS; `diffProcessResource(before, after)` rejects identity/counter regression. `discoverWorkerd(ownerPid)` requires exactly one owned descendant. `patchSource(arm, path, source)` produces transformed source and applied hook IDs; `hookTargets(arm)` declares every required source anchor.

- [x] Test PID/identity/counter mismatch rejection and actual counters on an owned short-lived child.
- [x] Test exact-anchor drift rejection and compile transformed source.
- [x] Preserve Promise identity, await order, exception behavior and stream reads; count only existing operations.
- [x] Record unsupported exact boundaries, native/async attribution, and local clock behavior explicitly.

## Task 3: Three-arm runner and frozen contracts

Files: `harness/build.ts`, `manifest.ts`, `entry.mjs.template`, `runtime.ts`, `fixture.ts`, `contracts.test.ts`, `run.ts`.

- [x] Define validated A/B/R arm records, fixed workload cells, exact-byte fixtures and semantic output oracle.
- [x] Preserve existing A/B immutable build resolver constraints; add an on-load transform only for declared diagnostic hook targets.
- [x] Build uninstrumented and diagnostic artifacts; record source, lock, runtime, tool and output hashes before execution.
- [x] Bind each arm's own schema and synthetic seed; use identical fixture egress and reject unrelated outbound traffic.
- [x] Use request-owned numeric trace state, bounded buffers and strict settlement; keep incomplete/error traces.
- [x] Retain all offered/terminal/dispatch IDs, raw wire evidence and physical storage evidence, with exact counts.
- [x] Test invalid/incomplete manifests, missing markers, wrong output, duplicate IDs and unsupported comparison classification.

## Task 4: Qualification and first measurements

- [x] Run focused harness tests and typecheck; do not rerun the product suite for tool-only changes.
- [x] Run a bounded real-workerd feasibility canary with all three entrypoints, D1 schema, correct wire output, dumps and exact Inspector identities.
- [x] Qualify source hooks, process identity, clocks and resource endpoint sampling.
- [ ] Qualify warmed instrumentation overhead and richer profile/time-series observers before using their timings.
- [x] Freeze the final run count/deadlines; collect the six-cell comparison in balanced arm order, retaining all partial evidence if it cannot qualify.
- [x] Produce independent aggregation and review. Distinguish full behavior from matched source-format diagnostics-off behavior; make no equal-work claim.
- [x] Update completion checkboxes with actual evidence; identify localized costs and remaining gaps. More workload dimensions are conditional on the first results, not automatic repeated testing.

## Task 5: Local delivery

- [x] Recheck protected files and reference cleanliness, source identity, owned process cleanup and evidence preservation.
- [x] Commit only the new tooling/design/results and merge completed work to local vNext under existing authorization.
- [x] Document what was measured, what remains unqualified and the next optimization priority. No CFW deployment is part of this plan.

## 2026-10-07 execution checkpoint

- [x] Implement exact 65,536-byte requests, six proposed cell labels, balanced arm orders and fail-closed Chat wire/population oracles. A final three-arm manifest is still pending.
- [x] Freeze new and reused harness files, consumed A/B inputs, source transforms, generated entry and bundles. Reject changed compiler bytes.
- [x] Run four isolated A/B control/probe instances, two cold string requests each, with real SQL/R2 readback, exact Inspector/process identity, advancing local clocks and CPU/RSS/heap endpoints.
- [x] Check per-request trace IDs/bounds, four SSE frames/source bytes, physical file counts/bytes, and normalized full upstream request equality across control/probe.
- [x] Preserve failed canaries 01/02 and successful canary 03; all three supervision receipts report cleanup complete.
- [x] Complete R runtime binding and a semantic/capture oracle over its physical reader. Adapter schema unit tests alone do not qualify a live R Worker.
- [x] Complete the three-arm runner/manifest/aggregation; the executable now supports all three commands.
- [ ] Complete warmed balanced observer-overhead qualification; the pilot explicitly disables observers.
- [ ] Add independent latency, OS accounting, V8 profile and heap time-series windows; retained ownership, slow-reader/cancel and capacity work remain later milestones.

**Protocol correction:** canary 02 proved forced SSE is invalid for A's native JSON request (502 parsing `data:` as JSON). Canary 03 honors upstream `stream`; A/B are JSON-to-JSON while R's intended path is SSE-to-JSON. The JSON cells therefore compare complete behavior with differing upstream format. SSE-to-SSE remains the first common-format comparison.

**Historical blocker (October 7, resolved October 8):** exact R dependencies were missing; offline frozen-lock installation could add zero packages, and official/mirror HTTPS failed during TLS. R and the formal 5,400-request proposal remained unrun at that checkpoint. No warm/capacity claims can be derived from its eight cold canary requests. The October 8 pilot below supersedes the R runtime blocker, while the larger formal proposal remains unrun. See the [historical results and gaps](../research/2026-10-07-reference-stage-measurement/qualification-results.md).

**Local delivery:** commit `dbbef72e` was fast-forwarded into local `vNext`. An independent review verified 41 evidence artifacts, 42 executable inputs, 1,953 A/B consumed compiler inputs and 12 runtime artifacts. The 39 MAIN and 14 repair protected files matched before integration; only the task-owned initial design was replaced by its documented update, with the original retained as `main-design-before-merge.md` in the new raw directory. No push or deployment occurred.

## 2026-10-08 execution checkpoint

- [x] Recover exact reference dependencies in the isolated archive using the unchanged pnpm lock and disabled lifecycle scripts; preserve failed attempts and verify source/dependency identities.
- [x] Build R from its real Cloudflare entrypoint with native Durable Object exports/binding, original dependency resolution and complete compiler-input receipts.
- [x] Seed R with native catalog projection/codec/revision, explicit record-shaped flags and root-origin custom-provider URL; freeze host helper identities against the build inputs.
- [x] Implement the shared qualified runtime, R native physical readback oracle, frozen 108-window warmed pilot and independent saved-evidence aggregation.
- [x] Independently review A/B native usage/performance populations, raw planned request shapes, saved-evidence revalidation and uninstrumented CPU-window boundaries.
- [x] Pass fresh R control/probe and extracted A/B control/probe qualification after correcting native record correlation and pre-affinity canonical-stream assumptions.
- [x] Run all 108 independent windows in balanced arm order, with 540 warmup and 2,160 timed requests. Freeze inputs first; retain any failed window without retry or selective pooling.
- [x] Independently reaggregate and document the qualified comparison, block variation, whole-process CPU, EOF-only latency and RSS endpoint limitations.
- [x] Recheck protected files, preserve all failed evidence, run focused harness tests/strict typecheck and merge only this delivery into local vNext.

The October 8 canary failures have localized measurement-adapter assumptions, not established product regressions. R generates dump IDs during background persistence and has no A/B-style dump-ID response header. Native record correlation must use the unique stored request marker and full request bytes. Its canonical response is observed before the affinity egress wrapper; raw client capture must still exactly match the observed wire. All final arms use a native-valid one-hour positive dump retention (or NULL when disabled), with response history disabled.

The warmed pilot is a bounded exploratory revision, not completion of the original 5,400-request proposal. Only `sse-string-common` is a common-source-format, diagnostics-off comparison. JSON cells preserve A/B JSON-to-JSON versus R SSE-to-JSON. CPU profiles, warmed observer overhead, first-semantic timing, memory time series/peaks, capacity and rollback qualification remain separate work.

**October 8 live qualification:** `qualification-ab-03` (four fresh host/workerd instances, eight requests) and `qualification-reference-07` (two instances, four requests) passed all client-wire, source-hook, native storage, ownership, settlement and cleanup gates. `qualification-reference-06` also passed before fresh-host isolation. A/B attempts 01 and 02 retained readiness failures; the latter emitted a broken fd 3 control pipe before any B request. Twenty-four minimal startup trials did not reproduce it. Fresh-host isolation is an experimental lifecycle boundary, not a claim that an underlying Bun/Miniflare defect was diagnosed.

**Frozen execution:** `warm-pilot-01` started after the latest harness validation (131 tests, 808 assertions, strict TypeScript success). Each instance runs in a fresh non-detached Bun child within the outer owned process group. Job/context hashes, normal child exit and complete group cleanup become additional independent offline gates. The 108-window run completed with all 2,700 requests passing. Independent saved-evidence aggregation and a separate Python numeric review both passed; outer and all inner process groups were clean. See [the measured results and remaining gaps](../research/2026-10-07-reference-stage-measurement/warm-pilot-results.md).

**Measured outcome:** B aggregate CPU is below R in all six cells, but above A in four cells, nearly equal in JSON diagnostics-off and below A in JSON-container-full. Block signs vary, so this is an exploratory direction rather than a universal regression/improvement claim. B's median whole-process RSS endpoints remain about 7–21 MiB above A; peak/isolate-memory improvements are unproven. Prioritize diagnostic serialization/compression/persistence profiles, then the small diagnostics-off SSE difference. R's always-on affinity carrier and JSON upstream format differences rule out an equal-work claim.

**October 8 local delivery:** measurement tools, result tables, machine-readable summary and evidence index were committed as `11441a41b11d9171c2dab115ab1bd383d81a9c1c` and fast-forwarded into local `vNext`. Post-merge verification kept all 38 MAIN and 14 repair protected files unchanged. The 56 evidence-index roots and 8,940 saved pilot artifacts passed size/hash validation. No push, CFW deployment or production access occurred. Remaining open items above retain their unqualified status.
