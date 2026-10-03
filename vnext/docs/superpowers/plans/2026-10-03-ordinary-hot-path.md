# Ordinary Hot-Path Optimization Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Preserve all evidence and mark each completed item.

**Goal:** Remove repeated dial preparation and capture operations while preserving ordinary request correctness.

**Architecture:** Request-scoped eager configuration availability, lazy fallback construction, exact selected authoritative execution, and bounded passive capture with fewer temporary objects.

**Tech Stack:** TypeScript, Bun, SQLite, existing local workerd harness.

**Spec:** `vnext/docs/superpowers/specs/2026-10-03-ordinary-hot-path.md`

## Global Constraints

The specification's Binding constraints apply to every task: existing worktree, protected38/14, original fixture, no deployment/push/install/cleanup, no wire/schema change, preserve routing/capture/terminal contracts, no cross-request execution cache. Root alone owns staging and commits. Agents modify only their assigned paths.

## Task 1: Dial preparation

**Files:** `packages/gateway/src/data-plane/dial/per-request.ts`, `packages/gateway/src/data-plane/providers/registry.ts`, `packages/dial/src/proxy-catalog.ts` and its exports if required. Tests: `data-plane-per-request-dial.test.ts`, `providers-registry-proxy.test.ts`, `routing-materialization.sqlite.test.ts`, existing dial proxy-catalog tests.

**Interfaces:** Consume pinned configuration rows for eager read preflight and accepted CatalogResult rows for selected execution. Produce request-local fetcher resolvers with unchanged `(upstreamId, observer?) => Fetcher` semantics; parsing helper remains framework-pure. Existing createPerRequestFetcher callers retain eager construction.

- [ ] Add meaningful boundary tests for eager repository failure before contribution catches, direct-only no read, delayed parsing against captured rows, request-only materialization, and authoritative selection after proxy change. Pin unknown-ID and malformed-ID privacy.
- [ ] Verify new boundary tests fail for the missing split, then implement shared parser/preparation helpers and direct single-upstream construction. Keep accepted and pinned sources separate and remove unused all-provider execution setup.
- [ ] Run the focused affected suites and gateway/dial typechecks, recording commands and results in W/task-1-report.md. No runtime measurement yet.
- [ ] Independent task review; fix load-bearing findings and commit only the reviewed task files.

## Task 2: Capture preparation

**Files:** `packages/gateway/src/shared/dump/accumulator.ts`, `upstream-attempts.ts`, `upstream-dial-adapter.ts`. Tests: existing dump accumulator/finalization, `upstream-attempts.test.ts`, `upstream-dial-adapter.test.ts`.

**Interfaces:** Existing collector/finalization APIs retain their outputs; header input may accept Headers as well as its existing iterable contract. No new persistence fields or transport observer ownership.

- [x] Pin source header immutability and final X-Dump headers across finalization branches; native/iterable safe-header equivalence; saturated-prefix EOF/cancel/error/count behavior including shared-budget exhaustion.
- [x] Remove the intermediate header clone, use native synchronous header traversal with the shared sanitizer and retain generic iterable fallback, and latch copying off when the response or shared budget is exhausted.
- [x] Run the focused affected suites and gateway typecheck; record results and mechanism evidence in W/task-2-report.md. Avoid tests that merely mirror private implementation.
- [x] Independent task review; fix load-bearing findings and commit only the reviewed task files.

## Task 3: Combined qualification and measurement

**Files:** New W evidence under `.superpowers/sdd/2026-10-03-ordinary-hot-path`; tracked report under `docs/superpowers/research/2026-10-03-ordinary-hot-path/`. Existing harness and old evidence remain unchanged.

- [ ] Verify protected bytes, changed-path inventory and exact commits; run full ci:local once after both reviewed deliverables. Fix actual failures before freezing.
- [ ] Freeze fresh A/B bundles using unchanged harness after generated assets settle; save exactB HEAD/overlay/inventory. Run separate four-request canary and inspect physical/Inspector/cleanup success before formal run.
- [ ] Run one five-unit716-request formal comparison. Preserve failures as partial if any; retry only after a demonstrated correction, never to obtain favorable numbers.
- [ ] Independently recompute outcome/resource data and review physical evidence. Require zero B wire/capture failures in addition to complete physical collection and both no-regression gates.
- [ ] Record measured benefits/costs and remaining release gaps without causal across-run or cloud/peak claims.

## Task 4: Local delivery

- [ ] Whole-increment independent code/evidence review; resolve substantive findings.
- [ ] Verify only authorized paths are staged, commit documents and fast-forward local vNext under prior authorization.
- [ ] Verify both heads/indexes, protected38/14, expected product changes and fixture identity; save integration receipt. No push/deployment/cleanup.
