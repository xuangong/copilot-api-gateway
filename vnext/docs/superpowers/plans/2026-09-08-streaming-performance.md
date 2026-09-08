# Streaming Performance Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with scoped implementation and review. User has approved the design intent; execute continuously.

**Goal:** Deliver streaming performance collection, aggregation and UI without misleading historical values.

**Architecture:** Shared protocol-neutral metric contracts, request-local observers, additive SQLite/D1 aggregate tables, scoped API, and separate browser measurements.

**Tech Stack:** Bun, TypeScript, Hono, React, SQLite, Cloudflare D1.

**Spec:** ../specs/2026-09-08-streaming-performance-design.md

## Global Constraints

- Preserve existing uncommitted min-token fix. Stay in the existing authorized vNext checkout for continuity; no branch replacement or automatic commits.
- New migration only, no secrets/logged user content, bounded aggregate storage, null for unobserved data.
- Exact public interfaces and timing semantics are in the approved spec. Backend owns the shared contract. UI imports it.

### Task 1: Backend collection, persistence and API

**Files:** new protocols/common/performance-metrics.ts; new gateway metrics observer/repository; gateway chat-flow attempt/respond/context; platform SQLite/D1 schema handling; migration 0009; control-plane performance routes and focused tests.

**Interfaces:** Produce the types and GET /api/performance/metrics response exactly as specified. Keep old PerformanceRepo and usage API compatible. Choose a separate performanceMetrics repo rather than forcing new required fields onto legacy writers.

- [x] Write failing clock-based classifier tests: start/heartbeat ignored, reasoning before text, tool-only output, empty/single chunks, missing usage, stream cancellation, JSON fallback.
- [x] Implement reusable observer and integrate real upstream dispatch timing and post-translation client output observation across Messages/Responses/Chat/Gemini. Capture completion before async storage.
- [x] Write real SQLite tests for repeated aggregate writes, nullable metrics, histogram merge, outcome separation, range/key filters and legacy coverage.
- [x] Add atomic migration/new-table initialization and test SQLite/D1 parity and retry safety.
- [x] Add authenticated/scoped route with tests for owner, assignee, admin and shared redaction; forbidden keys must contribute no metrics or legacy counts.
- [x] Run targeted tests and typecheck. Self-review all paths. Record report at /tmp/copilot-performance-backend-report.md; do not commit.

### Task 2: Dashboard and browser measurement

**Files:** dashboard api/performance.ts, state/performance.ts, tabs/latency/LatencyTab.tsx, tabs/models browser metric collector/panel/stream parsers/ChatPanel; i18n and tests.

**Interfaces:** Import Task 1's contract; locally merge distributions with count/sum and histogram rank, null for missing. Browser observer uses performance.now and explicit nonempty output categories.

- [x] Write failing aggregation tests using unequal sample counts, missing metrics and histogram ranks; test each filter including mapped identities and outcomes.
- [x] Replace latency totals with metric table, scoped filters, comparison table, sample count and legacy notice. Retain existing date/timezone navigation.
- [x] Write browser measurement tests for delayed first text, thinking/tool output, multi-chunk gaps, single chunk, cancellation, no usage and continuation timing.
- [x] Wire parser observations and usage into one collector per send; show concise footer and expandable per-message details, labelled browser observation.
- [x] Test frontend typecheck/build, Chinese/English and responsive browser behavior. Record report at /tmp/copilot-performance-ui-report.md.

### Task 3: Integrated verification and delivery

- [x] Review both tasks against every spec paragraph; resolve correctness findings.
- [x] Run full bun run ci:local. Exercise actual mapped Messages streaming and native protocols via local gateway with fixture upstreams.
- [x] Deploy with migrations to CFW and rebuild the three Docker targets already authorized. Verify source hashes, schema and real streaming metrics under the same key.
- [x] Update checklist with evidence and report outcome and any measurement limits.

## Delivery evidence (2026-09-08)

- CI: 3491 pass, 1 skip, 0 fail; all typecheck/build/dry-run gates passed.
- Independent review: 52 real-app usage scenarios and 8 reproductions pass; 361 targeted tests pass; no unresolved blocker.
- Browser: Chinese/English, desktop/mobile, three streaming protocols, cumulative continuations, buffered cancel and continuation limit pass.
- Deployed CFW version `a3cd64fc-75da-4279-b065-b18e2424bec0` with migration 0009, desktop-linux/orbstack/SSH Docker rebuilt and restarted. All four environments passed real streaming/nonstreaming metrics and health checks; three Docker runtime hashes match. Original min-token 1/16 sync/stream live CFW requests remain 200.
- Report: `/tmp/copilot-performance-delivery.md`; logs and backup paths recorded there. No commit or push.
- Measurement limits and the separately observed pre-existing Responses JSON fallback text issue are documented in the report; the latter was not changed by this performance patch.

## Rate correction delivery (2026-09-08)

- [x] Replace the mismatched full-usage / output-arrival-span rate with `upstreamTps`: full reported output usage divided by complete upstream call time, including single-block and JSON responses. Missing usage or zero denominator stays unknown.
- [x] Retire `outputTps` from API/UI, keep stored historical rows, and collect the new rate only from new requests. Rename generation duration to output arrival span; browser keeps only whole-send throughput.
- [x] Regress buffered 0/1/34 ms output, hidden reasoning, multiple calls with external tool waits, missing usage, legacy database rows and saved browser snapshots.
- [x] Full CI: 3497 pass / 1 skip / 0 fail; typecheck, lint (0 errors), UI build and Worker dry-run pass. Browser and independent review pass.
- [x] Deploy CFW `da820172-2e05-47e1-aabf-3ca0e0fd5c1b` plus desktop-linux/orbstack/SSH Docker. All four health/stream/nonstream checks pass; each Docker matches 57 runtime source hashes. No new migration.
- [x] Live Astra arithmetic: 5 output tokens / 1.979 upstream seconds = 2.5265 tok/s, one new sample, no retired rate returned. Short smoke validates arithmetic only, not representative speed.
- Evidence: `/tmp/copilot-rate-correction-delivery.md` and `.json`, `/tmp/copilot-rate-correction-ci.log`, `/tmp/copilot-rate-correction-browser.log`, `/tmp/copilot-rate-correction-image-verification.log`, environment smoke logs.
- Remote backup: `/home/xian/dockers/copilot-api-gateway-deploy-backups/rate-correction-20260908T083229Z`. No commit or push.
