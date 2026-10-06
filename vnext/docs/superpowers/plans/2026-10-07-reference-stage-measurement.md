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
- New tools live in `research/2026-10-07-reference-stage-measurement/harness`; raw output lives in `.superpowers/sdd/2026-10-07-reference-stage-measurement`.
- Preserve all dispatch, stream demand/cancel, diagnostic content and settlement behavior. Sampling, clocks and CPU scopes must retain their limitations.
- Reference feasibility inspection found installed dependencies missing or different from its pnpm lock. The initial no-install assumption cannot produce a valid R artifact. Prepare a Git archive in the new owned raw directory and install only there using its frozen lock and `--ignore-scripts`. Record the package manager identity, lock/patch identities and installation outcome. Do not mutate either project's installed dependencies or substitute B versions. This is an isolated measurement prerequisite, not a product dependency change.
- The reference Worker requires its real exported `ExecutionDO` and `EXECUTION_DO` binding; bind these even when the chosen HTTP fixture does not use native WS.

## Task 1: Reference artifact and persistence adapter

Files: `harness/reference-adapter.ts`, `harness/reference-adapter.test.ts`; a separate readback module if needed.

Interface: `buildReference(root, out, options?)` returns bundle, migration root, consumed original file identities and transformation receipts. `seedReference(db, {baseUrl, apiKey, fixtureSecret, dump, model})` inserts a synthetic owner/key and one static custom Chat model. `readReferenceStorage` reports the reference schema and decoded physical objects; it must not pretend to use B's sidecar schema.

- [x] Verify declared import/lock identity, source containment and missing-dependency rejection before accepting a bundle.
- [x] Test real schema seeding and malformed descriptor/object failure behavior before implementation acceptance.
- [ ] Build the real Cloudflare entrypoint with existing Bun options; freeze all consumed source/dependency files and original-to-transformed hashes.
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

- [ ] Define validated A/B/R arm records, fixed workload cells, exact-byte fixtures and semantic output oracle.
- [x] Preserve existing A/B immutable build resolver constraints; add an on-load transform only for declared diagnostic hook targets.
- [ ] Build uninstrumented and diagnostic artifacts; record source, lock, runtime, tool and output hashes before execution.
- [ ] Bind each arm's own schema and synthetic seed; use identical fixture egress and reject unrelated outbound traffic.
- [ ] Use request-owned numeric trace state, bounded buffers and strict settlement; keep incomplete/error traces.
- [ ] Retain all offered/terminal/dispatch IDs, raw wire evidence and physical storage evidence, with exact counts.
- [ ] Test invalid/incomplete manifests, missing markers, wrong output, duplicate IDs and unsupported comparison classification.

## Task 4: Qualification and first measurements

- [x] Run focused harness tests and typecheck; do not rerun the product suite for tool-only changes.
- [ ] Run a bounded real-workerd feasibility canary with all three entrypoints, D1 schema, correct wire output, dumps and exact Inspector identities.
- [ ] Qualify source hooks, instrumentation overhead, process identity, clocks and resource sampling before formal timing.
- [ ] Freeze the final run count/deadlines; collect the six-cell comparison in balanced arm order, retaining all partial evidence if it cannot qualify.
- [ ] Produce independent aggregation and review. Distinguish full behavior from equivalent diagnostics-off work.
- [x] Update completion checkboxes with actual evidence; identify localized costs and remaining gaps. More workload dimensions are conditional on the first results, not automatic repeated testing.

## Task 5: Local delivery

- [x] Recheck protected files and reference cleanliness, source identity, owned process cleanup and evidence preservation.
- [ ] Commit only the new tooling/design/results and merge completed work to local vNext under existing authorization.
- [ ] Report what was measured, what remains unqualified and the next optimization priority. No CFW deployment is part of this plan.

## 2026-10-07 execution checkpoint

- [x] Implement exact 65,536-byte requests, six proposed cell labels, balanced arm orders and fail-closed Chat wire/population oracles. A final three-arm manifest is still pending.
- [x] Freeze new and reused harness files, consumed A/B inputs, source transforms, generated entry and bundles. Reject changed compiler bytes.
- [x] Run four isolated A/B control/probe instances, two cold string requests each, with real SQL/R2 readback, exact Inspector/process identity, advancing local clocks and CPU/RSS/heap endpoints.
- [x] Check per-request trace IDs/bounds, four SSE frames/source bytes, physical file counts/bytes, and normalized full upstream request equality across control/probe.
- [x] Preserve failed canaries 01/02 and successful canary 03; all three supervision receipts report cleanup complete.
- [ ] Complete R runtime binding and a semantic/capture oracle over its physical reader. Adapter schema unit tests alone do not qualify a live R Worker.
- [ ] Complete the three-arm runner/manifest/aggregation and warm balanced observer-overhead qualification. The current executable is `qualify-ab` only.
- [ ] Add independent latency, OS accounting, V8 profile and heap time-series windows; retained ownership, slow-reader/cancel and capacity work remain later milestones.

**Protocol correction:** canary 02 proved forced SSE is invalid for A's native JSON request (502 parsing `data:` as JSON). Canary 03 honors upstream `stream`; A/B are JSON-to-JSON while R's intended path is SSE-to-JSON. The JSON cells therefore compare complete behavior with differing upstream format. SSE-to-SSE remains the first common-format comparison.

**External blocker:** exact R dependencies are missing; offline frozen-lock installation could add zero packages, and official/mirror HTTPS failed during TLS. Keep R and the formal 5,400-request proposal unrun. No warm/capacity claims can be derived from the eight cold canary requests. See the [results and gaps](../research/2026-10-07-reference-stage-measurement/qualification-results.md).
