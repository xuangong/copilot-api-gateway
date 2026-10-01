# Task 1 Review

## Spec Compliance

- **PASS for Task 1.** Reviewed base `fdc8c515` through head `ec253a3d406d14f815ff04a7f826707c07739dec`, using the supplied review package. All ten source/test files listed in the task brief have corresponding changes. No blocking missing, extra, or misunderstood Task 1 requirement was found.
- The phase API, readonly plan/call collections, `Omit<WebSearchExecutionSession, "pageCache">` input and synchronous `cancel(): undefined` match the brief: `vnext/packages/gateway/src/data-plane/tools/web-search/execution-scope.ts:4`, `:11`, `:16`, `:29`. The source type assertion rejects an async cancellation implementation (`:23`).
- Preparation uses the existing splitter after the open check; it does not call the resolver, provider or usage broker. Start remains single-use and retains eager page batching plus per-plan launch: `execution-scope.ts:98`, `:104`, `:108`. Existing single-query waiting versus multi-query fanout remains unchanged in `plan-operations.ts:175`, `:184`, `:190`.
- Owned work registers rejection/success observation before invoking each factory, separately tracks complete provider/usage leaves, and removes settled registrations rather than retaining history: `execution-scope.ts:43`, `:49`, `:50`, `:57`; `operations.ts:515`, `:610`. The top-level planner/fetch registrations remain present while asynchronous resolution and mapping occur (`execution-scope.ts:108`, `:110`).
- Cancellation closes admission/delivery synchronously, removes the parent listener, aborts only the local controller, clears the owned cache and rejects waiting deliveries. Settlement remains tied to actual pending registrations: `execution-scope.ts:33`, `:63`, `:81`, `:91`, `:97`.
- Provider resolution, usage-wrapper invocation, post-usage processing, cache writes and plan execution have cancellation guards: `operations.ts:477`, `:514`, `:521`, `:609`, `:616`, `:645`, `:695`, `:788`; `plan-operations.ts:176`, `:192`. Signal state and recognized abort exceptions stop both fallback paths; ordinary error/empty fallback still uses the existing loop: `key-config.ts:180`, `:204`.
- The Jina and Microsoft retry changes add only the pre-attempt signal check; delay arrays, attempt limits, status conditions and transport retry policy remain unchanged in their supplied hunks: `providers/jina.ts:86`, `providers/microsoft-grounding.ts:33`.
- The temporary adapter is explicitly documented and preserves its existing signature: `plan-operations.ts:198`. Its removal is a Task 2 obligation, not a Task 1 defect.

## Strengths

- **The settlement model covers the important fail-fast case.** Each query broker promise receives its own registration, so rejection of the multi-query aggregate cannot make a surviving sibling disappear. The unchanged broker functions really await usage in `finally`, as checked in `vnext/packages/gateway/src/data-plane/tools/web-search/search.ts:13` and `fetch-page.ts:13`. Deferred real-SQLite coverage checks both query siblings and late page usage: `vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts:97`, `:207`.
- **Delivery revocation is independent of cooperative provider cancellation.** A pending `result()` rejects on close while `settled()` remains pending until real work completes; after-close access is also rejected. This is directly covered at `execution-scope.test.ts:63`. Registration-before-factory also handles synchronous cancellation/reentrant settlement (`:189`).
- **The regression cases exercise actual behavior.** The preserved RED logs show swallowed abort incorrectly advancing to Bing and a late page repopulating the cache. The new tests use actual broker code and real SQLite rather than module-wide persistence mocks: `key-config.test.ts:364`, `plan-operations.test.ts:130`, `execution-scope.test.ts:27`.
- **Compatibility changes stay narrow.** Optional tracker parameters preserve direct callers, and the Alpha route still builds the same session and calls the same operation API: `vnext/packages/gateway/src/data-plane/alpha-search/routes.ts:186`, `:196`. Normal fanout/order, replay argument retention, batching/cache reuse, ordinary fallback and retries have focused coverage (`execution-scope.test.ts:39`, `:133`; `providers.test.ts:245`; the final focused log).

## Issues

### Critical

- None found.

### Important

- None found.

### Minor

- **Verification-output hygiene only; non-blocking.** `.superpowers/sdd/2026-10-01-hosted-search-execution-contracts/task-1-final-lint.log:1` contains the resolver's multiple-projects configuration advisory. The report calls it existing; this review confirms the output but did not independently establish its baseline origin. It is not evidence of a Task 1 source defect or a failed lint run. Keep it explicitly qualified when reporting the final validation; do not describe all command output as warning-free. Any resolver configuration cleanup belongs outside this narrowly scoped review unless the controller elects to include it.
- **Observed test diagnostics, no defect inferred.** `task-1-final-focused.log:52` and `:56` contain intentional-looking 401/403 failures, followed by 429 retry diagnostics and passing named refresh/retry fixtures (`:55`, `:59`). These are distinguishable from unhandled rejections or failed assertions. No additional Task 1 warning/failure appears in the execution-scope test section.

## Focused Checks and Evidence

- Read the supplied diff as the implementation view. The tool truncated its first output, so only the omitted middle span of the same package was retrieved. No changed source file was separately reread and no Git command was run.
- **Named risk: tracking only an aggregate or provider result might omit awaited usage.** Inspected only the unchanged `search.ts` and `fetch-page.ts` broker wrappers. Both await their provider and the usage `finally`; the new tracker wraps those full returned promises.
- **Named risk: fallback abort recognition could differ from existing shared behavior.** Inspected `vnext/packages/gateway/src/data-plane/shared/abort.ts:13`. The fallback reuses the same existing helper that traverses error causes; it also checks the signal to handle custom reasons and swallowed abort envelopes.
- **Named risk: added operation parameters could break Alpha or existing hosted callers.** Performed a focused symbol call-site search and inspected only Alpha's session construction and calls. Tracker parameters are optional. The two hosted call sites still use the documented staged adapter (`chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts:347`, `chat-flow/responses/interceptors/server-tools/web-search.ts:490`).
- Read the preserved RED fallback, cache and missing-module logs, plus the retry RED summary. The fallback/cache cases demonstrate old behavior, while the report accurately identifies the missing-module RED and later retry mutation check as different forms of evidence.
- Read the final focused, typecheck, purity, lint and protected-file logs. The focused log reports **136 pass, 0 fail, 442 assertions across 7 files** (`task-1-final-focused.log:206`). It includes Alpha prefix mounting and retained-route behavior (`:78`, `:82`, `:94`). Typecheck reports exit 0, purity reports OK, and the protected log reports 38 main / 14 isolated files. No suite was rerun and no new probe was needed: the inspected code raised no unresolved concern requiring execution.

## Cannot Verify in This Task Gate

- **Hosted end-to-end lifetime ownership is not complete in this diff.** Task 2 must adopt the scope in both hosted callers, guard protocol delivery/reentry and remove `planWebSearchCalls`. The unchanged call sites above establish the staged boundary; this review does not claim those lifetimes are already fixed.
- Diagnostic snapshot cancellation belongs to Task 3 and is outside this diff. The final complete frozen-source CI and whole-branch review also remain controller obligations.
- Alpha compatibility evidence is local injected-transport test evidence, not a production or external-provider run. Existing tests and the unchanged API support compatibility, but this task gate does not establish every external service behavior.
- Protected hashes and command completion are supported by the provided logs/report, not independently recomputed here. Commit/index membership, the original protected manifests and fixture process liveness were not re-inspected because this task explicitly prohibited Git mutations/commands and service operations.
- No measured CPU, memory, latency or Cloudflare resource improvement is established. A noncooperative provider/repository may leave real settlement pending; the code establishes prompt local delivery revocation and observation, not remote termination.

## Assessment

**Task quality: Approved.** The implementation is narrow, preserves existing scheduling and direct operation signatures, and separates prompt cancellation from real settlement without introducing timeouts, capacity policy or hidden serialization. No Task 1 fix is required before proceeding to the planned caller migration; retain the explicit staged-integration and validation limitations above.
