# Whole-increment source review

Date: 2026-10-01

Range: `648a521eaa6c20a4ce937525e01c87093f46c8f4..522df8ae1e012dfdf0484c3d381669a494573b08`.

## Scope and evidence

Reviewed the supplied frozen diff in focused sequential passes, the binding specification and plan, and the progress ledger. Inspected surrounding execution scope, Chat producer owner, Responses dispatcher/materializer/error owner, provider retry helpers, and actual Dashboard hook wiring. Inspected the added boundary, lifecycle, real SQLite, route backpressure, snapshot, and state-generation test implementations; prior task execution results remain task-reported evidence, not newly executed whole-increment CI.

This was a read-only source review except for this report. No tests were rerun: no unresolved source concern required a new narrow execution, and the fresh complete CI is explicitly scheduled after this review/fix wave. No network, production access, installation, service operation, index change, HEAD change, or protected-overlay modification was performed.

## Strengths

- Operation admission precedes parser expansion and both normal/refusal branches; the same execution scope survives hosted reentry. Sparse arrays are charged by length. Scope-owned, single-consumption tokens keep reservation separate from expansion without refunds.
- Successful-body admission is shared across configured fallback and page helpers without provider-owned invocation counters. Chunk admission precedes copying, the reader uses bounded blocks and admitted EOF, and capacity errors cross the built-in provider and native Messages catches unchanged. The ingress failure immediately aborts the shared scope with the original safe reason. Retry loops observe that signal; fallback checks it around each engine. Real started provider/usage ownership is retained, including the corrected Jina and Microsoft all-settled helper batches.
- Owned retained maps recheck closure, count, old replacement charge, and available bytes after reflection. Admission is atomic for the candidate; previous entries survive failed replacement where the owning domain remains open. Reads do not re-estimate or clone. The documented borrowed-graph contract and exclusion of external legacy stores are consistent with implementation.
- Responses private registration remains synchronous and occurs before completed item frames in `server-tool-shim.ts:952`. Capacity rejection reaches its existing failed-response owner and prevents model reentry. Chat charges generated additions and annotations before committing them to retained history, excluding repeated base messages; its existing producer owner closes search work when the generator fails.
- Bounded broker subscriptions retain encoded strings and check state after awaited delivery and codec reentry. Overflow discards payloads and detaches without throwing from EventTarget callbacks. Generic subscription behavior remains separate. Routes acquire permits after authorization, subscribe before SQL, and retain permits until actual started SQL/writer settlement. Terminal writes are serialized after an already-started write, with no promise of terminal delivery through a blocked transport.
- Latest snapshots account for the envelope and SQL-page cursor as well as admitted rows. An all-omitted page still supports older browsing; oversized envelopes produce a finite capacity terminal. The actual hook uses `DumpLiveSession` for stale source/page invalidation, explicitly closes overflow streams, and resets the list/cursor on manual refresh. Appended events do not clear continuity or omission warnings. No periodic SQL polling or automatic inference replay was introduced.

## Issues

### Critical

None found.

### Important

None found.

### Minor

1. **An all-omitted live snapshot simultaneously claims there are no retained requests.**
   - Location: `vnext/apps/dashboard/src/tabs/requests/RequestsPanel.tsx:55`.
   - The empty-state predicate checks only loading, list error, and visible record count. A valid latest snapshot with `records: []` and `omittedRows > 0` therefore renders both the omission warning and “No retained requests. Capture may be disabled or records may have expired.” The server has explicitly established that records existed but could not fit the live representation.
   - This is misleading UI wording, not lost persistence or broken pagination: the snapshot cursor and older-page affordance remain available.
   - Minimal fix: require zero omitted rows for that empty-state message, or use an accurate no-visible-records message for the omitted case. Add a small presentation regression case if the empty-state predicate is extracted or rendered through the existing fixture.

2. **Exact estimator traversal boundaries and nested replacement admission deserve small regression cases.**
   - Locations: `vnext/packages/gateway/tests/data-plane/tools/web-search/retained-capacity.test.ts:16` and `:52`.
   - Current tests reject comfortably excessive depth/value counts and cover retirement during reflection. They do not pin the exact accepted/rejected 64-depth and 65,536-visited-value boundaries or insertion/replacement during reflection.
   - Source inspection found the necessary post-reflection count/old-charge checks in `capacity.ts`, so this is coverage hardening rather than a demonstrated capacity escape.
   - Minimal fix: add exact boundary pairs with ample byte budgets, plus one nested insertion/count case and one nested same-key replacement/net-byte case. Keep these tests local to the retained-capacity suite.

Inherited resolver advisories and fixture HTTP logging are not findings in this increment and need no resource-policy fix.

## Recommendations

A single small optional fix wave can resolve the contradictory empty-state wording and add the retained-map boundary/reentry regressions. Preserve the current domain-specific admission and existing lifetime owners; no redesign or additional runtime policy is indicated by this review. Run the planned fresh complete CI once on the final frozen artifact, including the protected overlays, and verify the protection/index/source identity before local integration.

The review establishes source mechanisms and accounting semantics only. It does not establish physical heap bounds, latency or CPU improvement, production-safe numeric limits, complete historical recovery, catalog/affinity rollback compatibility, or publication readiness. The documented later measurement and compatibility gates remain open.

## Assessment

**Ready to merge? Yes, from source review, conditional on fresh complete CI and final artifact/protection verification.**

No blocking findings were identified across the four tasks or their ownership/error-path interactions. The two minor items can be addressed together before that CI; this verdict is not authorization to push or deploy.
