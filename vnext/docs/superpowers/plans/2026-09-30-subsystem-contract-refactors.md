# Subsystem Contract Refactors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Check each deliverable after review and validation.

**Goal:** Close demonstrated authority, resource ownership and execution-contract weaknesses without changing deployment or public protocol semantics.

**Architecture:** Retain the modular monolith and portable host adapters. Give shared state bounded retention, separate pinned configuration reads from current commands, describe the actual event producer explicitly, and reduce repeated query work. Keep compatibility completion as the existing transport contract.

**Tech Stack:** Strict TypeScript, Bun, SQLite/D1, Hono and local Wrangler/workerd tooling.

**Spec:** [Quality attribute architecture](../specs/2026-09-30-vnext-quality-attribute-architecture.md), [subsystem design](../specs/2026-09-30-vnext-subsystem-architecture-design.md), [source findings R1-R10](../research/2026-09-30-subsystem-architecture/README.md).

## Global Constraints

- No CFW deployment, remote writes, Docker replacement or push. Integrate reviewed commits into local `vNext` under existing authorization.
- Preserve the 37 original main-workspace files and the corresponding 13 physical files in the existing isolation; do not include them in commits.
- Reuse `.worktrees/cfw-resource-rollback-fix` and its dependencies. Do not create another installation or stop existing services.
- Keep native JSON, lazy event/body adaptation, authority/CAS fencing, all eligible affinity candidates, existing error precedence and HTTP/WS compatibility completion.
- Provider responses remain byte-level. Do not derive runtime producer type from telemetry.
- Preserve soft quota, fail-open behavior, pricing fallback, unknown/zero, UTC boundaries and existing auth policies.
- Use real SQLite for persistence tests. No database mocks, new `any`, or non-null assertions.
- English source/docs; Chinese progress. Targeted correctness tests per slice; one final integration qualification, with resource comparisons reported separately.

## Task 1: Catalog retention owner

**Files:** `packages/gateway/src/data-plane/providers/catalog-coordinator.ts`; a focused `catalog-retention.ts` if needed; `packages/gateway/tests/catalog-coordinator.sqlite.test.ts` and a focused retention test.

**Interfaces:** Preserve `CatalogCoordinator.read(request): Promise<CatalogResult | null>` and catalog identity/publication ordering. Add policy limits for retained entries, models and estimated bytes; defaults align with routing projection ceilings (512 entries, 16384 models, 16 MiB estimated bytes). Oversized accepted snapshots remain usable for the current request without shared retention. Retained metadata must not hold request provider/credential/fetcher closures.

- [ ] Add failing tests for aggregate model/byte eviction, oversized request-local success, replacement/clear accounting, and stale-publication protection.
- [ ] Implement owner accounting and release at every eviction/clear/replacement. Do not mutate a cached result to install the current request's row; construct the returned request view locally.
- [ ] Run `bun test packages/gateway/tests/catalog-coordinator.sqlite.test.ts` and the new retention tests; review discovery modes, lease/CAS and warm reuse.
- [ ] Commit the scoped change and record review/validation.

## Task 2: Configuration authority and invalidation

**Files:** `packages/gateway/src/repo/configuration-cache.ts`, `repo/index.ts`, new `repo/configuration-ports.ts`, `shared/credential-auth.ts`, data-plane consumers of `getDataPlaneRepo`, `tests/configuration-snapshot.test.ts`, `tests/configuration-fresh.sqlite.test.ts`.

**Interfaces:** Export a read-only `DataPlaneConfiguration` surface with only the auth/routing reads required by consumers; retain explicitly authoritative repository operations for credentials, catalog observation, usage and commands. Exhaustive method classification must fail compilation when a new configuration repository method is not classified as read, mutation or specially handled state update. HTTP disabled-key-owner compatibility remains distinct from WS required-enabled-owner policy.

- [ ] Reproduce cached-session acceptance after logout with a real SQLite-backed later admission.
- [ ] Add `deleteByToken` invalidation and exhaustive typed classification. Make pinned reads incapable of invoking writes through their public type; migrate consumers without introducing per-request SQL.
- [ ] Verify same-request snapshot semantics, later-admission revocation, fresh WS admission, and live credential recovery with targeted configuration/auth tests.
- [ ] Commit the scoped change and record review/validation.

## Task 3: Bounded quota projection

**Files:** `packages/gateway/src/repo/types.ts`, `repo/shared/usage.ts` (or the actual shared usage implementation), `data-plane/observability/quota.ts`, `shared/usage-cost.ts` if necessary; `tests/repo-usage.test.ts`, `tests/observability/quota.test.ts`, new quota projection tests.

**Interfaces:** Add a quota-specific aggregate repository projection used only after detecting configured quotas. Return sufficient grouped totals to preserve the existing `recordCostUsd` fallback semantics without materializing every hour/model usage record. No schema or policy changes.

- [ ] Add SQLite parity cases for known zero, unknown dimensions/cost, fallback pricing, image/cache weights, multiple hours/models and end-exclusive month boundaries.
- [ ] Implement SQL aggregation and switch the configured-quota path. Keep no-quota requests free of usage queries and retain existing denial order/messages.
- [ ] Verify old computation and new projection give equivalent totals and decisions using real data; record query/row structure, without claiming an unmeasured latency win.
- [ ] Commit the scoped change and record review/validation.

## Task 4: Explicit event producer and settlement contracts

**Files:** `packages/protocols-llm/src/common/result.ts` (actual result type), `packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts`, `responses/source-result.ts`, `responses/turn.ts`, protocol attempt/respond call sites and focused tests. Do not overwrite original overlay files; coordinate if one must be changed.

**Interfaces:** A tagged producer domain carries the actual event protocol independent of `modelIdentity.translatorPair`; source adapters consume the tag and retain lazy JSON/event translation. Expose execution facts and projection receipts separately from compatibility completion, without waiting on completion to construct projection input. Existing WS waits and HTTP delivery timing stay intact.

- [ ] Add regressions where producer identity is correct while telemetry is absent/stale, and where a delayed sink must not prevent execution facts from resolving.
- [ ] Implement the producer boundary, migrating real producers/consumers rather than adding an unused optional tag. Keep byte-level providers and localize necessary validation casts.
- [ ] Implement the smallest usable facts/receipt seam; verify no circular waits, single settlement, cancellation, semantic failures and full WS cleanup gate.
- [ ] Run source-result, turn-barrier, translation traversal and affected protocol tests; commit reviewed scoped changes.

## Task 5: Exhaustive provider and preparation declarations

**Files:** `packages/gateway/src/data-plane/providers/registry.ts`, `chat-flow/responses/serve.ts` and an extracted `responses/prepare.ts` if needed; provider/native preparation tests.

**Interfaces:** Bundled provider plugins use `satisfies Record<UpstreamProviderKind, ProviderPlugin>` before constructing any lookup. Unknown persisted provider kinds keep their current failure behavior. Native Responses preparation exposes a discriminated ready/failure result reused by applicable generate/compact entrypoints; avoid a second execution owner. Route capability co-location is limited to actual duplicated decisions demonstrated by these edits.

- [ ] Add coverage for all known kinds and unknown persisted kinds; retain provider defaults/proxy error ordering.
- [ ] Make registration exhaustive and extract the typed preparation phase where duplication exists.
- [ ] Verify preparation preserves quota/history/affinity order and generate/compact response status behavior; do not touch unrelated route policy.
- [ ] Commit the scoped change and record review/validation.

## Task 6: Capture/publication resource contract

**Files:** `packages/gateway/src/shared/dump/accumulator.ts`, `types.ts`, store/serialization owner as needed, focused dump ownership tests and documented resource policy.

**Interfaces:** Define per-capture and environment-retained budgets plus release points for canonical event capture and publication. Overflow must produce an explicit diagnostic outcome, never a silently truncated successful dump. Normal configured diagnostics remain exact. Keep one forward reader and existing compatibility settlement, without adding an unbounded queue or parallel compression.

- [ ] Inspect storage/capture contracts and choose explicit lossless admission failure or marked diagnostic overflow; document policy and which allocations remain outside the bound before code changes.
- [ ] Add boundary tests for concurrent capture, oversized frames, cancellation, successful write, rejected write and publication release; preserve client response bytes/status.
- [ ] Implement enforceable owner-level accounting with bounded estimation work and exact release. If existing format cannot represent overflow compatibly, complete the design and record the migration prerequisite rather than silently changing diagnostics.
- [ ] Run affected dump tests; commit reviewed implementation or document the concrete blocker.

## Integrated closeout

- [ ] Review all changed contracts together; verify plan status and preserve unrelated file hashes.
- [ ] Run `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` once on the final isolated candidate, fixing failures and rerunning only affected gates before completing the integrated chain.
- [ ] Fast-forward local `vNext` with scoped commits, recheck hashes/index and report exact source/overlay qualification.
- [ ] Record completed/partial/deferred items, evidence limits and next priorities. Resource CPU/heap comparison remains a separate exact-artifact gate; no production performance claim.

## Explicit follow-up boundaries

History item-reference migration, accounting outbox/idempotency, strict quota reservations, HTTP/WS auth policy change, physical store split and broad dashboard query migration remain separate projects. They require their own semantics or workload evidence; this batch must not introduce them incidentally. Full capture of arbitrarily large data and absolute memory bounds cannot both be promised: any cap requires a visible, tested overflow contract.
