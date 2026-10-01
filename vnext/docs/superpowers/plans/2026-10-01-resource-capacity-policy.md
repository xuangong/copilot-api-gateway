# Resource Capacity Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task requires implementation evidence and an independent specification/quality review before completion.

**Goal:** Bound hosted-search admission and retention, and make diagnostic live-view overflow explicit without claiming lossless history recovery.

**Architecture:** Domain-specific admission owners precede work or retention. Existing protocol/persistence owners handle outcomes. Bounded diagnostic delivery exposes a limited latest-view recovery contract.

**Tech Stack:** Strict TypeScript, Bun, existing provider fixtures, SQLite, dashboard and Workers dry-run.

**Spec:** [Resource capacity and latest-view contracts](../specs/2026-10-01-resource-capacity-policy.md).

## Global Constraints

- Work in `.worktrees/cfw-resource-rollback-fix` with existing dependencies. No push, deployment, service restart, dependency installation or production access. Local vNext integration is authorized.
- Preserve all original 38 main / 14 isolated protected files and the existing Bun fixture; never stage protected files. Retain worktree and raw evidence.
- Preserve protocol completion, persistence and cancellation owners. Admission must precede the work it bounds. No automatic inference replay after a diagnostic failure.
- Preserve admitted fanout, page batching/order, replay arguments/extensions/IDs, ordinary provider fallback/retry and usage settlement, native JSON and existing tool-loop policies.
- Source/docs English, user communication Chinese. Strict TypeScript with no `any`, suppression directives or new non-null assertions. No new dependency, migration or environment variable.
- Focused validation while implementing; one complete CI on the final frozen source. Local workerd measurements are a later gate and must not be inferred from source mechanisms.

## Design convergence

- [x] Select separate operation, ingress, replay, cache and Chat continuation policies, explicit excess outcomes and original-call/reentry coverage.
- [x] Select bounded diagnostic latest-view queues and visible finite recovery; separate publication and history navigation work.
- [x] Freeze specification, task boundaries and fresh protection baseline before implementation.

### Task 1: Admit hosted search operations before expansion

**Files:** Create `vnext/packages/gateway/src/data-plane/tools/web-search/capacity.ts` for safe typed errors and validated policy constants. Modify `execution-scope.ts`, Responses `interceptors/server-tools/web-search.ts`, Chat `with-chat-completions-web-search-shim.ts`; update exact execution-scope/caller tests. No protected files.

**Interfaces:** `WebSearchCapacityError` with safe category/limit. Policy defaults: operations 64, responseBodyBytes 1 MiB, ingressBytes 8 MiB, privateEntries 64, privateBytes 4 MiB, pageEntries 64, pageBytes 2 MiB, chatContinuationBytes 4 MiB. Strictly validate finite safe positive integers; injected test policies may lower but not exceed defaults. Add a scope-owned admission token: `admit(args)` counts and reserves; `prepare(admission)` consumes it and expands; `refuse(admission)` consumes without parsing. Tokens cannot cross scopes or be consumed twice. Keep owned counters private and clear token ownership on cancellation.

- [ ] Write RED boundary tests: sparse huge array rejected without reading elements, supported/unsupported/null/empty counting, two queries charge two despite a merged plan, exact capacity then excess, cross-scope and repeated token use.
- [ ] Implement early count and atomic reservation with saturating arithmetic and own-key enumeration, no element enumeration or eager slot/provider work. No refund on abandoned preparation.
- [ ] Integrate both callers before normal preparation and iteration-refusal branches; scope survives reentry. Capacity throws to existing failure owner without successful refusal/reentry after exhaustion.
- [ ] Verify actual callers across turns, refused-call budget, no start for overflowing call, normal fanout/malformed behavior, cancellation semantics. Run focused tests, gateway typecheck, purity, scoped lint and protection verifier. Commit only task source/tests; report RED/GREEN commands/logs and concerns.

### Task 2: Bound successful provider body ingress

**Files:** Add a narrowly scoped success-body reader in `tools/web-search/providers/`; modify `capacity.ts`, `types.ts`, `execution-scope.ts`, `operations.ts`, `key-config.ts` and built-in providers Tavily, Jina, LangSearch, Microsoft grounding, Bing and Copilot. Extend corresponding focused tests, including alpha compatibility where shared provider changes affect it.

**Interfaces:** Scope owns a monotonic 8 MiB ingress debit capability forwarded through search/fetchPage requests and helper/fallback/retry paths; shared configured providers carry no request counter. Reader enforces 1 MiB per response (independently for standalone use), checks both budgets synchronously before retaining a whole chunk, copies into bounded blocks, decodes/parses only after admitted EOF, and throws `WebSearchCapacityError` on excess. Policy injection is internal for tests, no new public config.

- [ ] RED tests for exact EOF/plus one, deceptive Content-Length, oversized chunk/backing buffer, tiny chunk stream, UTF-8 boundaries, null body, malformed JSON and jointly excessive concurrent bodies.
- [ ] Route all built-in successful JSON/text reads through the bounded reader, including extraction/reader HTML and Copilot text/SSE. Keep error-body policy and Alpha/model streaming scope unchanged. Do not fall back to unbounded response.text/json when body is null.
- [ ] Propagate capacity unchanged through provider broad catches, per-page catches and operations/configured fallback; no later engine/retry/model continuation after capacity failure. Record started usage and retain existing real-settlement ownership.
- [ ] Confirm every successful read site, representative built-in search/page paths, existing fallback and usage normal cases. Focused tests/types/purity/lint/protection only. Commit source/tests and detailed implementation report.

### Task 3: Admit retained replay, page cache and Chat continuation

**Files:** New bounded noncloning estimator near `tools/web-search/capacity.ts`; owned page cache helper there if needed. Modify `orchestrator/server-tools/private-payload-store.ts`, `execution-scope.ts`, `operations.ts` and Chat web-search interceptor. Add focused private-store/cache/Chat retention tests; check Responses writer-before-completion behavior using existing private lifecycle fixture.

**Interfaces:** Estimator charge: string/key 32 + 2*length, object 64, array 64 + 8/slot, property 16, primitive 8; limit visited values to 65,536 and depth to 64. Reject symbol keys, accessors, exotic prototypes, functions and cycles. Inspect all own data properties, preserve JSON extensions, account IDs/keys and net replacement, no clone/stringify/freeze. Defaults: private 64/4 MiB, page 64/2 MiB, Chat generated state 4 MiB. Separate domains use the shared typed capacity error; no ordinary-error fallback.

- [ ] RED tests for count and bytes, ignored/extension fields, replacement preserves old value on failure, invalid graphs and disposal; Chat tests charge arguments/tool strings/new annotations once while excluding repeated base input.
- [ ] Enforce default owned private scope before insertion and completed frames, without changing synchronous writer shape. Preserve delegated legacy store behavior and document its excluded capacity guarantee.
- [ ] Replace scope-owned cache Map with narrow bounded get/set/clear capability; standalone low-level sessions remain structurally compatible. Admit actual graph before publishing page success, no eviction/refetch and no late writes after close.
- [ ] Add incremental Chat generated-state admission before retention/reentry, with no duplicate charging of base/history each turn. Preserve original data/extensions, citations and protocol error owner.
- [ ] Focused actual-caller/lifecycle/cache/normal tests, types/purity/lint/protection; commit and report exact evidence plus remaining temporary-owner limits.

### Task 4: Bound diagnostic live queues and expose limited recovery

**Files:** Modify `shared/runtime/channel-broker-contract.ts`, `event-target-channel-broker.ts`, dump broker/registry/bootstrap as necessary, `control-plane/dump/routes.ts`; create small dump policy/route-permit owner modules if needed. Modify dashboard `api/dumps.ts`, `state/dumps.ts`, `tabs/requests/RequestsPanel.tsx` and existing i18n files for added visible labels. Focused broker/route/real-SQLite/auth/dashboard state tests. Preserve full detail/export and protected files.

**Interfaces:** Generic subscribe stays compatible. Bounded capability returns iterable plus synchronous terminal-state access/cancel. Queue 100 frames/256 KiB; frame 16 KiB; charge 2*encoded.length+128. Retain encoded strings with bounded-path lazy decoding. Overflow reasons queue_count/queue_bytes/frame_bytes, latch once, clear queued payloads/detach, reject next once then done. Route permits 4 per key/16 total, no wait queue, 429 Retry-After 5 before subscription/list. Keep permits until real started SQL/writer settlement.

- [ ] RED broker and route cases for exact boundaries, pending-reader oversize, overflow before first pull/during SQL/blocked writes/post-await delivery, abort and graceful drain, reentrant codec, permit saturation and late-settlement retirement.
- [ ] Implement bounded capability and production route use including legacy URLs. Keep raw abort immediate and subscribe-before-snapshot. No concurrent overflow write or unhandled pending-read rejection.
- [ ] Add `?view=latest-v1`: bounded newest-fitting snapshot with view latest/limit 100/omittedRows/completeHistory false, and reconciliation_required {reason,recovery:latest_snapshot,completeHistory:false}; legacy event shapes stay intact and overflow closes. Correct stale cross-isolate replay claims.
- [ ] Update dashboard to opt in, persist best-effort/continuity warning separately from network error, close explicit-overflow source and offer Refresh latest. Refresh starts a new generation, resets list/cursor using latest snapshot, ignores stale callbacks. Keep existing older browsing. No background polling or claim of complete recovery; browser accumulated history remains a documented gap.
- [ ] Verify ordinary snapshot→appended ordering, auth failures, storage-before-notification, explicit overflow and missing-terminal disconnect behavior; test state transitions outside React hooks and render scope/refresh affordance. Focused suites/types/purity/scoped lint/protection. Commit source/tests and report.

## Qualification and integration

- [ ] Complete each implementation and independent task review, marking checked items after accepted evidence.
- [ ] Complete whole-increment review and resolve findings.
- [ ] Freeze a new artifact including protected overlays; run one complete `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local`.
- [ ] Fast-forward local vNext, verifying source identity, protection inventories, empty indexes and fixture identity.
- [ ] Archive evidence and remaining workerd/rollback/publication/history gates. Inspecting the runner is not completing measurement.
