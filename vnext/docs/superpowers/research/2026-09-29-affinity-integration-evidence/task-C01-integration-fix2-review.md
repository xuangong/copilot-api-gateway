# C01 integration fix2 scoped re-review

- Frozen product base: `b09541c5988ab1c916b753d70c850964637ebaf3`.
- Inputs: fix2 brief, previous fix1 review, appended fix2 implementation report, and the complete 10-file `task-C01-integration-fix2-review.patch` relative to fix1.
- Read-only SHA-256 verification: **38 files checked, zero mismatches** against `task-C01-integration-fix2-frozen-sha256.json`.
- **Spec compliance verdict: Approved for this scoped fix.**
- **Task quality verdict: Approved for this scoped fix.**
- No new blocking breakage established in the fix diff. Root's frozen runtime/full-CI acceptance remains a separate completion gate.

## Open Important dispositions

| Open finding | Disposition | Review evidence |
| --- | --- | --- |
| Actual transport abort on rejected opaque stream | **ADDRESSED** | `fetchAffinityUpstream` adds a dedicated child AbortController to the actual provider request, wraps its returned body, and explicitly aborts that child before underlying reader cancellation. The prior guard/parser return chain now reaches a real transport abort while preserving caller/error/telemetry signals. |
| Arbitrary tool fields misclassified as opaque state | **ADDRESSED** | Guard checks use named event/envelope positions and native item/block types. They no longer recurse into application input/result/metadata. Related egress detection and incomplete-item stripping also use native field positions, preventing tool-data deletion or unnecessary codec initialization. |

## Transport lifecycle inspection

At `vnext/packages/gateway/src/data-plane/shared/affinity-request.ts:102-143`:

- Only the shallow provider request copy receives the child signal; the original request signal remains the caller signal. Responses, Messages, and Chat hub attempts all invoke this wrapper at their actual provider-fetch boundary.
- Caller abort is linked one way to child abort. Internal body rejection never aborts the caller. Therefore the responder can still emit its sanitized error and record an error rather than falsely classify it as downstream cancellation.
- The returned body owns one reader. On cancellation it sets its local cancelled flag, aborts the transport, detaches the caller listener, cancels the reader, and releases the lock. A pending pull checks that flag before enqueue/close/error, avoiding use of the released reader or closed output controller after cancellation.
- EOF, read failure, provider-fetch rejection, empty body, and explicit cancel clean up the caller listener idempotently. Body/read errors also abort the child. Successful EOF does not need to abort an already completed transport.
- No-context requests retain the original request and signal identity. Provider-owned retry/refresh remains inside the same fetch and keeps its existing discarded-body ownership; the wrapper owns the returned response body.
- Existing parser/translator/gateway async-iterator return plumbing remains intact. The fix therefore addresses the previously established Bun distinction between reader cancellation and HTTP transport abortion rather than merely adding another generator cleanup assertion.

The added lifecycle tests cover caller non-abortion, transport-abort-before-underlying-cancel ordering, active caller disconnect, no-context signal identity, and listener cleanup across EOF/body failure/fetch failure/empty response. These tests were inspected, not rerun.

## Protocol and source-JSON boundaries

At `gateway/src/shared/affinity/egress.ts`, Responses checks inspect recognized reasoning/compaction/program slots and direct nested agent encrypted blocks, with the companion fields used by analysis. Messages checks inspect thinking/redacted blocks at content-block/message-start positions. Tool inputs, results, and embedded business type/key strings do not become native state. The revised `hasOpaque` and incomplete-event stripping follow those same positions, preserving application fields throughout egress and keeping lazy secret loading restricted to signable native items.

The source-JSON extension is appropriate to the binding fix: an explicit upstream `text/event-stream` now reaches its protocol parser even when the client requested JSON. Both source responders already place the guard before hub reassembly, then translate the complete hub body, sign the source body, and use the existing completion/persistence path. The upstream request's stream parameter is not changed. With no explicit SSE content type the previous fallback behavior remains.

The extra reconstruction changes preserve the newly exercised path:

- Messages reassembly retains complete initial tool input when no input JSON deltas replace it.
- Messages reassembly appends thinking and signature deltas to their initial native fields, allowing complete-companion source signing.
- Messages-to-Responses streaming retains initial tool arguments and emits them before finalization when no argument deltas arrive.
- The entrance guard still owns accumulation bounds; translators/reassemblers do not independently stamp carriers.

Actual route regressions cover native/cross-protocol source SSE and source JSON with upstream SSE, ordinary initial/delta tool payloads containing oversized business `signature`/`encrypted_content`/`fingerprint` fields, no secret creation for those tools, complete thinking/signature reconstruction, and authenticated replay. They assert error metrics rather than cancellation, and prohibit a success terminal/carrier on overflow. No assertions were relaxed to accept the previous failures.

## Evidence and remaining boundaries

I reviewed the complete scoped diff and the named surrounding source-JSON dispatch/reassembly and transport lifecycle paths. I ran only read-only frozen-file hashing, not the writer's suites or root's runtime probes. No product or Git/index changes, commits, push/deploy, or subagents.

Implementation-reported verification, not independently rerun here:

- Expanded affected suite: **1232 pass, 0 fail, 3263 assertions, 131 files**.
- Final actual HTTP/SQLite route suite: **22 pass, 146 assertions**.
- Six touched package typechecks, repeated final gateway/translate types, and diff check passed.
- 38-file lint: zero errors and one previously existing warning.

Root reported mutable Bun plus independent Node-upstream diagnostics now observe close after **9 of 40 chunks**, with error metrics, no successful snapshot, and successful source-JSON-from-SSE replay groups. These are root-owned pre-freeze diagnostics at report-writing time; the final frozen runtime and full-CI result must be attached by root before acceptance. This scoped approval does not independently claim those pending runs passed.

Previously accepted companion reconciliation, group-v2 nested binding, lazy identity capture, authoritative owned replay, and zero-SQL ordinary warm dispatch are retained. Previous explicit scope deferrals remain unchanged: Custom/Azure owner compatibility producer, Chat/Gemini client carrier adapters, and complete Claude account authority. No claim of overall C01 completion or deployment readiness is made.
