# Workerd Deployed Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect defensible local comparison evidence against the deployed baseline without changing product behavior.

**Architecture:** A frozen-input manifest feeds a parent supervisor with five fresh child units. Each child owns its runtime, durable journal, deadlines, physical readback and strict receipt; an independent aggregate qualifies the experiment.

**Tech Stack:** Bun, TypeScript, installed Miniflare/workerd, Node process/fs APIs, local D1/KV/R2.

**Spec:** `vnext/docs/superpowers/specs/2026-10-02-workerd-deployed-comparison.md`

## Global Constraints

The Binding constraints section of the spec applies verbatim to every task. In particular, no product modifications, protected-file staging, installation, production, push, deployment or old-evidence cleanup. All raw evidence is retained. A is deployed e660fb4d; B is e90b8ee5 plus preserved overlay. Formal count is exactly 716 in five units; canaries are separate. No metric is called cloud CPU or peak memory.

## Task 1: Reliable runner, frozen inputs and variant adapters

**Files:** Create tooling and focused tests in `vnext/docs/superpowers/research/2026-10-02-workerd-deployed-comparison/harness/`; report in the plan workspace. Prior harness is read-only.

**Interfaces:** Consume explicit source A/B paths and fresh artifact/output paths. Produce a manifest with input digests, a canary CLI, a five-unit supervisor CLI, append-only journal entries, child receipts and an aggregate JSON. Put exact CLI usage and output schemas in the harness README. Root supplies baseline adapter audit separately.

- [x] Read old run.ts, inspector.ts, dump-readback.ts, entry.mjs.template, upstream-fixture.ts, oracle.ts and baseline/current sources. Map source/dependency locations explicitly; do not copy old implicit PLAN paths.
- [x] Add focused failure-first tests for incomplete/duplicate count rejection, manifest drift, durable journal error recovery, stage timeout and owned-process cleanup, exact inspector target, and legacy/current stored bodies. Test actual child cleanup with a disposable child, not a mocked kill.
- [x] Implement the manifest freeze, supervisor, unit and physical adapters. Keep independent modules for journal/receipt, runtime execution, inspector and physical readback. Preserve the existing deterministic fixture, ABBA and request timing semantics.
- [x] Prove completion invariants using an actual set of request IDs, not only array length. The aggregate's equivalent predicate must include:

```ts
const exact = offeredIds.size === expected && terminalIds.size === expected
  && [...offeredIds].every(id => terminalIds.has(id))
const collected = exact && eofComplete && dispatchExactlyOnce && storageReadback
  && backgroundSettled && cleanupComplete && identitiesMatch
```

- [x] Run focused tests and standalone typecheck; record exact output and red/green failure evidence. Self-review the diff and commit only the new harness files. No runtime comparison yet.
- [x] Independent task review of specification compliance and code quality; resolve load-bearing findings before Task 2.

## Task 2: Freeze and run isolated local comparison

**Files:** Create fresh manifest, bundles, canary and run directories under `.superpowers/sdd/2026-10-02-workerd-deployed-comparison/`; write qualification/results in the tracked research directory.

**Interfaces:** Consume reviewed Task 1 CLI/manifest. Produce immutable raw evidence, completed or incomplete aggregate and an auditable analysis with paths/hashes. Never combine independent run attempts.

- [x] Reverify deployed HEAD/clean status, candidate product inventory/protected hashes, empty indexes and fixture identity. Inventory ignored assets and actual installed runtime before the matched builds. Evidence: `preflight-protection.json`, `preflight-inputs.json`, and baseline audit; recheck before formal freeze if inputs change.
- [x] Freeze/build A/B into fresh absolute directories with identical options; verify inputs after build.
- [x] Execute a separately identified canary under bounded supervision; verify real start, ordinary JSON/SSE body/readback, inspector and physical stop. If it fails, preserve output and diagnose the narrow failure before changing tooling.
- [x] Diagnose Formal 01 from original evidence: distinguish eleven reader false failures from four historical capture defects; preserve the 19 strict wire failures and the incomplete run.
- [x] Amend the matrix observation contract explicitly, retaining the original specification and obtaining principle review. Require separate strict wire/capture outcomes and pass-to-fail gates, with all both-failing pairs unresolved.
- [x] Review and qualify the narrow reader corrections and amended outcome/join implementation; ordinary and physical checks remain strict. Freeze all amended bytes and rerun a fresh canary before a new formal sequence. Exact implementation `c3f5923f`, Freeze 04 / Canary 04 passed.
- [x] Run the declared five units sequentially through the supervisor. Check stage checkpoints while running; terminate only owned children through the supervisor if deadlines expire. Formal 02: 716/716, five successful children with physical cleanup, aggregate exit 0.
- [x] Analyze durable completion rows with exact count/ID matching, per-mode/block latency, separate CPU/heap records, matrix outcome comparison, storage costs and complete cleanup. Keep any partial attempt as partial. Independent recomputation reports no problems; [results](../research/2026-10-02-workerd-deployed-comparison/results.md).
- [x] Independent evidence review against raw journal/receipts/manifest; no rerun solely to obtain a favorable number. Full physical review PASS: 716/1,790 formal and 4/10 canary, 39,523 consistency checks, 9,536 frozen identities and 2,825 unchanged original evidence files.

## Task 3: Record boundaries and integrate locally

**Files:** Update this plan and tracked research README/results/qualification. Preserve the old capacity research and production evidence unchanged.

**Interfaces:** Consume reviewed implementation and Task 2 raw evidence. Produce an explicit completed/partial/gap record and local vNext integration receipt.

- [x] Mark completed checklist items and any unresolved gate precisely. Record catalog/affinity compatibility and cloud billed-CPU/peak-memory limits as remaining release work; see results and qualification.
- [x] Perform final whole-change review of tracked tooling/docs and evidence claims, with original input identities. Resolve final load-bearing findings. `final-increment-review.md`: PASS, no blocking findings.
- [x] Check unchanged product inventory and protected hashes, stage only this increment's paths, commit documentation, and fast-forward local vNext under existing authorization. The six harness commits were first integrated at `c3f5923f`; the accompanying documentation is delivered by the final local fast-forward recorded in `local-integration-receipt.json`.
- [x] Verify both local heads/indexes/protection/fixture and report concrete measurements with local-only status. Preserve all plan/run workspaces. Product 1,572, protected 38/14 and original fixture verified after the harness fast-forward; final documentation-head checks are retained in the integration receipt. No push/deployment; peak-memory, cloud CPU and catalog/affinity rollback gates remain open.
