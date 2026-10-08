# Diagnostic CPU attribution implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Track each completed item and keep source findings separate from measured attribution.

**Goal:** Localize B's diagnostic-path resource costs without weakening capture, ownership or settlement guarantees.

**Architecture:** Extend the qualified local runtime with an explicit observer mode, preserving existing uninstrumented windows. Collect a bounded B-only JSON experiment, then independently validate and map its raw CPU profiles. Source review identifies necessary guarantees and candidate repeated work. Product optimization is conditional on concrete evidence.

**Tech Stack:** Frozen Bun 1.3.0, Miniflare 4.20260601.0, workerd 1.20260601.1, local D1/R2/KV, exact-target CDP and existing source-map tooling.

**Spec:** [Stage measurement design](../research/2026-10-07-reference-stage-measurement/README.md), especially metrics, boundaries and observer qualification; [pilot priorities](../research/2026-10-07-reference-stage-measurement/warm-pilot-results.md#next-work-and-release-gaps).

## Global constraints

- Work in `.worktrees/cfw-resource-rollback-fix`, starting at `2d05a92cf044167d5ae3483182e09173cdda5336`. Preserve MAIN's 38 and repair's 14 protected files; snapshots are in `.superpowers/sdd/2026-10-08-diagnostic-attribution/`.
- No production access, deployment, push, dependency installation, existing-service restart, worktree removal or deletion/rewrite of earlier evidence.
- Product inputs remain the A/B manifest `05f341af-02b0-4c30-8c5d-9958b29ac722`, B freeze `cb5ca3b17736dabc6f217c36d3961a40f111cfe5` plus frozen overlay/assets. Revalidate consumed source and artifacts.
- New observer harness lives in `research/2026-10-08-diagnostic-attribution/harness`. Reuse the existing October 7 runtime and native readback by explicit options, not duplicate product or fixture logic.
- Compatibility date `2025-06-01`, flags `nodejs_compat`, `enable_ctx_exports`. All instances remain fresh non-detached children within the outer owned process group.
- Only B JSON `json-string-full` and `json-string-common`, exact 65,536-byte request, 20 ms synthetic upstream, concurrency one, history off and diagnostic retention 3600/NULL.
- Observer modes: `none`, `attached`, `cpu`. Two blocks use `[none, attached, cpu]` and `[cpu, attached, none]`; each block runs both cells, for 12 windows. Each window has 5 warmup and 30 timed requests: 60 warmup, 360 timed, 420 total. No selected rerun, retry or pooling failures. This explores observer effects; it does not establish statistical noise bounds.
- Source hooks and heap sampling remain off. CPU sampling interval is 1000 microseconds. Memory time series/slow-reader/cancellation and release qualification remain separate, explicitly open gates.
- Keep whole-workerd CPU, V8 sampled wall intervals, and host/CDP times distinct. Never multiply profile shares by process CPU or label V8 sample weights as billed/exact CPU.

### Task 1: Source cost and ownership audit

**Files:** `research/2026-10-08-diagnostic-attribution/source-audit.md` (root synthesis from independent raw audits).

- [x] Trace B diagnostics from raw ingress through canonical/upstream capture, compression, file registration, record commit, notification and release.
- [x] Compare A and R implementations, listing required guarantees, existing fast paths and concrete avoidable work candidates with source locations.
- [x] Preserve CPU causality and memory-peak gaps: operation counts/ownership alone do not quantify CPU or heap.

### Task 2: Explicit observer runtime and bounded runner

**Files:** modify October 7 `harness/runtime.ts` and `harness/warm.ts`; create October 8 `harness/observer.ts`, `observer.test.ts`, `run.ts` and `runner.ts` as needed. Do not change the old `warm-pilot` manifest/aggregation semantics or old `instance-job.ts`; reuse its exported `runInheritedProcess` in a dedicated new child entrypoint.

**Interfaces:**

```ts
export type ObserverMode = "none" | "attached" | "cpu"
// QualifiedInstanceOptions gains an optional observer mode/config independent of window.
// Default warm windows remain observer none; cold canaries retain their existing behavior.
// Export runAbWarmWindow(manifest, arm, window, directory, observer?) from warm.ts
// to reuse its current initialization and physical/native side-effect oracle.
// runner.ts must not depend on Task 3 profile aggregation to produce raw evidence.
```

- [x] First write meaningful observer lifecycle tests: start/stop ordering; no commands for none; attach-only no Profiler; errors from start/stop/close cannot yield a completed observer receipt; successful raw profile retained before later validation.
- [x] Test the fixed plan counts/order and fail-closed child/job/context identity. Run focused failing tests before implementation, then pass them.
- [x] Attach only to the exact gateway target. Prepare `Profiler.enable` and interval outside timed work. OS process start sample precedes `Profiler.start`; timed requests and their settlement finish before `Profiler.stop`; persist the raw result, then sample process end. Record host monotonic begin/end for start/stop and V8 native start/end. Process CPU includes Profiler start/stop overhead in cpu mode and is labelled accordingly.
- [x] No heap queries, forced GC, debugger pause or source hooks during profiles. Capture Inspector identity for attached/cpu; none must have no Inspector endpoint/commands. Preserve ordinary `warm-pilot` behavior.
- [x] Close Inspector explicitly and record success/failure; cleanup failures cannot qualify an observer run. Always dispose workerd and stop fixture even after failed start/stop/readback. Outer supervision still owns group termination.
- [x] Freeze plan, manifest, executable source/dependency inputs and job/context digests before instances. Write observations, raw profile, profile/observer lifecycle receipt, terminal/dispatch receipts, native physical readback, process identity and cleanup receipts for every window. Failed windows stop collection with durable partial evidence.
- [x] Do not launch the live experiment; root reviews and runs after both tool tasks pass tests/typecheck.

### Task 3: Independent raw-profile validation and source mapping

**Files:** create October 8 `harness/profile.ts`, `profile.test.ts`, `analyze.ts`.

**Interfaces:** `validateProfile(input: unknown)` validates raw CDP payload; `summarizeProfile(profile, mapper)` retains sample counts/time weights by mapped source and runtime category. Analysis is offline, after runtime/readback/disposal.

- [x] First test missing/unequal samples/deltas, invalid/duplicate nodes, unknown sample/child IDs, negative/nonfinite times and invalid tree rejection. Valid profiles must retain idle, GC, native/runtime, harness and unmapped buckets without reassignment to product code.
- [x] Map exact generated entry locations through its source map to the frozen product bundle and then its source map to original source. Freeze map files and mapping-library inputs. Unmapped frames stay unmapped; verify sourcesContent against frozen consumed source when assigning product source.
- [x] Preserve raw profile and node/sample detail; aggregate exclusive/self samples only. Report sample count, wall window, delta coverage/tail and unmatched frames. Do not sum inclusive call stacks or manufacture per-stage CPU.
- [x] Independently validate all expected window jobs, process identity, terminal/dispatch populations, readback and settlement. Compare same-cell normalized full upstream requests between observer modes and blocks.
- [x] Report per-window CPU/request and EOF, observer changes and profile buckets. Treat two blocks as exploratory; emit no general noise/overhead bound.

### Task 4: Live evidence, decision and local delivery

- [x] Run focused observer/profile/harness tests and strict TypeScript check once final tool bytes are frozen. Final delivery verification: 184 tests / 1,452 assertions and strict TypeScript passed, including the R2 inventory and exact module-URL follow-ups.
- [x] Run the bounded observer experiment under the outer deadline with preserved failures and no automatic retries. Observer-01 failed after its first 35 successful requests at post-envelope R2 inventory capture; preserved separately. After a fixture-reproduced harness correction, observer-02 passed all 12 windows / 420 requests; independent numerics and native semantic replay passed.
- [x] Document source-proven candidates, observed profile coverage, resource effects and the next action. Four CPU profiles have only 58 samples; configured 1 ms is not effective resolution. No function ranking or memory-limit resolution is claimed. See the results report.
- [ ] Mark completed items, commit only this task's docs/tools (and any separately qualified optimization), and fast-forward to local vNext under existing authorization. Verify protected files and reference cleanliness. No push/deployment.

## Measured outcome and follow-up boundary

- Observer-02 completed 420 requests with native saved-byte replay and an independent numeric check. Full/off no-observer CPU/request means were 7.895/4.592 ms. CPU-mode means were 10.994/6.131 ms; these are exploratory whole-process observations, not overhead bounds.
- Four profiles yielded only 58 samples. Original map proof passed, but relative module URLs were initially unresolved. A new offline remap tool proves the exact frozen module identity without modifying collection inputs or the original analysis. It maps 30 script samples and retains two internal D1 samples as unresolved.
- No product optimization or peak-memory claim is delivered. The next implementation priority is multi-page Base64 scratch elimination, followed by an owned-string gzip alternative and live metadata-only upstream lookup where worthwhile. Each retains current ownership, cancellation and persistence guarantees. Memory cadence, body/frame slopes and release/rollback gates remain separate work.
