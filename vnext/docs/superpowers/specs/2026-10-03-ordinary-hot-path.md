# Ordinary hot-path preparation and capture design

Date: 2026-10-03. Base: `58e4af245153c88a27f3b6dbafb98ee715b69de6` plus the preserved collaboration overlay.

## Objective and evidence

Reduce repeated ordinary-request preparation and capture work while retaining the current routing, diagnostic, terminal and ownership contracts. Formal 02 found higher candidate first-semantic SSE latency in all four blocks and no sampled CPU saving. Its sparse profiles identify dial/proxy preparation and upstream observation as investigation leads, not feature cost estimates. This increment changes product code; the previous comparison's tooling-only restriction describes that historical increment, not this one.

## Binding constraints

- Work only in the existing `fix/cfw-resource-rollback` worktree; integrate reviewed commits into local `vNext` under prior user authorization. No push, deployment, dependency installation, service restart or evidence/worktree cleanup.
- Preserve all 38 MAIN and 14 isolated protected file hashes from the new raw baseline. Do not stage, reset or stash those files. Preserve fixture PID 90455 and its original start identity.
- Keep routing visibility, pinning, malformed-proxy isolation, no-implicit-direct-fallback, authoritative selected credentials/proxies, colo fallback, retry/replay, backoff and request-local observer ownership.
- Keep complete sidecar objects, safe headers and omission counters, exact prefix bytes/budgets, full observed byte counts, lazy demand, cancellation/read-error/EOF distinction, terminal validation and background settlement.
- No public wire/schema/migration/config changes, no new cross-request execution or credential cache, no borrowed mutable capture frames, no disabling diagnostics.
- Follow vnext/AGENTS.md. No any, non-null assertion without local proof, database module mocks or new dependencies. Use real SQLite where repository semantics are exercised.
- Group correctness verification by deliverable, then run full ci:local and one fresh local workerd comparison after all product changes. Do not rerun to seek more favorable measurements.

## 1. Routing preparation boundary

Existing all-visible fetcher construction performs configuration preflight even when every stored provider will later use its accepted authoritative catalog observation. Keep the eager repository availability check outside the per-contribution catch, for all rows actually returned by the existing visibility listing, before contribution enabled/pin/colo filtering. The configuration listing already excludes disabled rows; do not widen it with includeDisabled. Direct-only configurations must not read proxy rows. Continue evaluating initialized repo/runtime prerequisites before routing succeeds.

Separate this eager read from request-only materialization: retain the proxy-row snapshot and referenced IDs within this request, but delay proxy parsing and the all-upstream fallback map/resolver until a request-token-only Copilot consumer actually needs it. The existing createPerRequestFetcher entrypoint remains eager for its existing callers. Malformed proxy URLs remain isolated to upstreams that reference them and expose only IDs at dial failure; a storage read failure remains fatal at preflight.

For a selected authoritative single upstream, construct its resolver directly from the accepted upstream and proxy rows, without wrapping them in a one-element async repository/array/map pipeline. Preserve the unknown-upstream-ID guard, parsed-proxy isolation and the existing createFetcher transport policy. Observation factories remain request/operation local. Never reuse pinned preflight proxies for accepted execution. Do not cache mutable fetcher/provider state across requests.

Framework-pure parsing belongs in packages/dial. Gateway owns repo/runtime lookup and orchestration. Reuse shared parser/factory logic rather than copying URI parsing or malformed-proxy error formatting between paths.

## 2. Capture boundary

### Private response headers

Dump finalization currently copies source headers into a temporary Headers and passes that to a new Response, which copies them again. Construct the final Response from the source headers once, then stamp X-Dump headers on the new response's private mutable Headers. Apply consistently to existing finalization branches. Preserve source headers, response status/statusText, body ownership, stored capture-time headers and existing idempotent finalization behavior. Do not mutate upstream responses.

### Native header traversal

Allow native Headers to reach the collector directly. Traverse them synchronously without creating iterator entry tuples, while retaining the existing iterable fallback for generic callers. Both paths share exactly the same safe-header normalization, order, limits, metadata reservations and omitted-header counting. Do not materialize an array of all headers or inspect caller RequestInit again. Native case normalization must not relax generic input validation. Exotic iteration/diagnostic failure remains best effort and must not affect transport.

### Saturated prefix copying

Once this response prefix or the collector's shared body budget is full, stop asking BytePrefix to append further bytes for this stream. Limits are monotonic during live capture, so the latch may only transition to inactive. Continue counting every consumed source chunk, forwarding the same bytes, preserving cancellation/read errors and reporting an exact total only on source EOF. Other attempts sharing the collector remain correctly accounted. Failed partial copies retain accurate accounting and cannot resume capture.

This saturation optimization mainly benefits larger responses; it is not presented as an explanation for the previous short ordinary fixture.

## 3. Alternatives and tradeoffs

Cross-request parsed-proxy/fetcher caches could save more work but need independent invalidation and retention contracts; defer them. Removing capture or relaxing frame ownership would reduce cost by dropping required behavior and is rejected. Combining stream observers might remove wrappers but would couple performance occupancy, diagnostic capture and cancellation owners; retain those boundaries in this increment. Local construction and traversal changes are smaller, independently reviewable and require no data migration.

## 4. Verification and measurement

Focused tests must cover the changed boundary behavior rather than only count implementation calls: eager read failure, lazy parsing over a captured snapshot, direct-only no-read, request-only fallback, authoritative stale/new proxy difference, unknown ID, malformed-ID privacy, native/iterable header equivalence including omission/order/budgets, original response header isolation, prefix saturation with later count/cancel/error/EOF and concurrent attempts.

Run full `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` from vnext after both deliverables and reviews. Record exact output; previous CI cannot qualify changed product bytes. Generated assets are frozen only after CI completes.

Reuse the existing 2026-10-02 harness unchanged with fresh output directories: deployed A e660fb4d and optimized B's exact committed HEAD plus preserved overlay. A must be clean; B must be a descendant of e90b8ee5. Preserve all earlier raw evidence. New spec governs product scope; inherit the previous measurement mechanics, exact716 offers/five units, separate canary, strict physical collection, dual matrix outcomes and cleanup predicates.

Additional acceptance: candidate B must have zero wire and zero capture failures, because pre-optimization B passed all126 cells in both channels. The harness's A-pass/B-fail rule alone could miss a candidate regression in an A-failing cell. Root checks B all-pass explicitly without editing the frozen harness.

Report within-run A/B latency, sampled non-idle time, settled heap and storage with their original limitations. Compare old/new B only descriptively across separate runs; do not label it a paired causal speedup or cloud CPU/peak-memory result. Real-account traffic, concurrency/slow-consumer peaks, hosted-search saturation and catalog/affinity rollback compatibility remain separate release gates.
