# Task 2 implementation report

Status: DONE_WITH_CONCERNS (qualification boundaries below). Date: 2026-10-01.
Base: `9391d2d5ee5983fd3307b386cf8e2f2c9a5aedc6`.
Commit: `c81e4639` (`fix(vnext/gateway): bound successful web search ingress`).
Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`.

## Implementation

A narrowly scoped success-body reader admits entire runtime chunks before copying into lazily allocated blocks of at most 16 KiB. It retains no network-chunk views or per-tiny-chunk storage entries. Exact-at-limit requires EOF. Content-Length is ignored as authority. Null native bodies are empty, without response.text/json fallback. Text decoding and JSON parsing occur only after admitted EOF; UTF-8 sequences span blocks through the decoder. The final text and JSON graph are temporary normalization owners, not covered by raw byte accounting.

Every built-in standalone successful reader enforces the 1 MiB per-response default. Hosted Responses/Chat execution scopes provide one monotonic synchronous 8 MiB invocation debit capability, explicitly forwarded through operations, configured fallback, and Jina/Microsoft page helpers. Per-response test limits come from the internal scope policy, with no public configuration. Shared configured provider instances own no invocation counters.

Per-response overflow invokes the scope failure latch immediately, before reader cancellation or promise propagation. Cumulative debit overflow latches synchronously inside debit. Both preserve the original safe typed reason and close admission/start/fallback gates before a later result slot is consumed. Capacity is rethrown by provider broad catches, Jina's inner JSON catch, per-page catches, operation catches and configured fallback. Existing scope cancellation revokes delivery promptly while existing work tracking waits for real provider/usage settlement. Public cancel remains synchronous and argumentless; the narrow ingress capability invokes existing internal cancel(reason).

Reader cancellation is best effort, observed but not awaited as the error completion decision. Abort can interrupt a pending noncooperative read and locks are released. A separate abort waiter is created only for each active read: reusing one unresolved abort promise would retain a race reaction for every tiny chunk. Prior waiters have no external root after the read finishes.

Successful sites checked: Tavily search/extract; Jina search/reader; LangSearch search; Microsoft grounding search/browse; Bing HTML; Copilot full text/SSE. Remaining response.json/text sites are Jina non-success JSON error decoding, Copilot non-success error text, and the existing shared error-body helper. Their policy was preserved.

Root explicitly expanded the task to narrowly rethrow WebSearchCapacityError from the Messages native search handler: otherwise the newly bounded standalone built-in could become an unavailable result and another model turn. No Messages invocation operation/cumulative ingress budget or loop redesign was added. Tests prove native Messages and Gemini-via-Messages emit no successful result/terminal frame and start no continuation. Alpha passthrough/model streams remain unchanged; Alpha local mode reuses bounded providers and capacity-aware operations, without receiving an invocation cumulative budget.

## Committed paths

Only these 19 source/test paths were staged (root docs and all protected overlays remained unstaged):

```text
vnext/packages/gateway/src/data-plane/tools/web-search/capacity.ts
vnext/packages/gateway/src/data-plane/tools/web-search/types.ts
vnext/packages/gateway/src/data-plane/tools/web-search/execution-scope.ts
vnext/packages/gateway/src/data-plane/tools/web-search/operations.ts
vnext/packages/gateway/src/data-plane/tools/web-search/key-config.ts
vnext/packages/gateway/src/data-plane/tools/web-search/providers/success-body.ts
vnext/packages/gateway/src/data-plane/tools/web-search/providers/tavily.ts
vnext/packages/gateway/src/data-plane/tools/web-search/providers/jina.ts
vnext/packages/gateway/src/data-plane/tools/web-search/providers/langsearch.ts
vnext/packages/gateway/src/data-plane/tools/web-search/providers/microsoft-grounding.ts
vnext/packages/gateway/src/data-plane/tools/web-search/providers/bing.ts
vnext/packages/gateway/src/data-plane/tools/web-search/providers/copilot.ts
vnext/packages/gateway/tests/data-plane/tools/web-search/success-body.test.ts
vnext/packages/gateway/tests/data-plane/tools/web-search/providers.test.ts
vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts
vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-messages-web-search-shim.ts
vnext/packages/gateway/tests/data-plane/chat-flow/messages/interceptors/with-messages-web-search-shim.test.ts
vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts
vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-fanout.test.ts
```

## RED and GREEN evidence

Logs are in this report directory. Reader/scope checks are discriminating temporary mutations of the implementation, restored in finally blocks before GREEN; they are not claimed as an initial preimplementation RED.

- `task-2-red-reader.log`: force the reader limit to its default rather than the injected limit; exact EOF/plus-one test fails, 0 pass / 1 fail. Command: `bun test vnext/packages/gateway/tests/data-plane/tools/web-search/success-body.test.ts --test-name-pattern 'exact EOF'`.
- `task-2-red-scope.log`: disable cumulative debit rejection; concurrent sublimit and cross-reentry search/page tests fail, 0 pass / 2 fail. Command: `bun test vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts --test-name-pattern 'concurrent sublimit|persists across reentry'`.
- `task-2-red-latch.log`: remove reader ingress.fail; per-body failure test finds the scope still open before result consumption, 0 pass / 1 fail. Command: same execution-scope file, pattern `responseBodyBytes capacity latches`.
- `task-2-red-messages.log`: real tests written before the narrow Messages production catch change; original catch converts capacity to unavailable, both native/cross-protocol tests fail, 0 pass / 2 fail. Pattern `successful search body capacity`.
- One initial reader mutation only disabled the limit comparison; the block allocator then stalled with a zero-size allocation beyond the intentionally disabled boundary. It was interrupted and the exact source restored; no such mutation remains. The successful RED instead raises the policy limit while preserving allocation invariants.
- Initial scoped GREEN had two fixture SQL assertions using nonexistent request_count; corrected to actual SUM(attempts). Actual scope/capacity assertions had already passed. Final log supersedes that run.

Final focused command from worktree root:

```sh
bun test vnext/packages/gateway/tests/data-plane/tools/web-search/{providers,success-body,execution-scope,key-config,plan-operations,test-connection}.test.ts vnext/packages/gateway/tests/data-plane/chat-flow/messages/interceptors/with-messages-web-search-shim.test.ts vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-fanout.test.ts vnext/packages/gateway/src/data-plane/alpha-search/__tests__/routes.test.ts
```

`task-2-green.log`: 206 pass / 0 fail, 590 assertions, 10 files, 7.91s.

Coverage includes exact boundary withheld EOF, plus-one, deceptive headers, oversized full chunk before debit, cancellation that never settles, large backing-buffer views and later mutation, many single-byte chunks and multibyte UTF-8 across blocks, null bodies, malformed JSON with monotonic debit, pending-read cancellation/lock release; all six built-in standalone search caps and three page reader caps; all search/page ingress forwarding; Tavily/Jina/Microsoft normal admitted search/page mappings without full-response methods; existing Bing/LangSearch/Copilot JSON/SSE normal paths; configured fallback normal cases; jointly excessive concurrent sublimit bodies; cross-reentry search/page accounting; both failure categories immediately latch before result consumption, block sibling fallback, preserve original reason and wait for real usage settlement (two attempts); Chat no tool output/next model turn; hosted Responses slot rejects and closes later admission; Messages exception escape/no successful terminal/continuation; existing Alpha local/relay compatibility, planner and cancellation regressions.

Responses slot tests qualify dispatch failure, not a new full HTTP protocol-owner end-to-end test. The previously established generic capacity outer owner is unchanged. No statement that these tests measure native workerd execution is made.

## Scoped checks and protection

From worktree/vnext:

```sh
bun run --filter '@vibe-llm/gateway' typecheck
bun scripts/check-framework-purity.ts
bunx eslint packages/gateway/src/data-plane/tools/web-search/{capacity,types,execution-scope,operations,key-config}.ts packages/gateway/src/data-plane/tools/web-search/providers/{success-body,tavily,jina,langsearch,microsoft-grounding,bing,copilot}.ts packages/gateway/tests/data-plane/tools/web-search/{success-body,providers,execution-scope}.test.ts packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-messages-web-search-shim.ts packages/gateway/tests/data-plane/chat-flow/{messages/interceptors/with-messages-web-search-shim,chat-completions/interceptors/with-chat-completions-web-search-shim,responses/interceptors/server-tools/web-search-fanout}.test.ts
```

`task-2-typecheck.log`: exit 0. Final type annotation uses Awaited<ReturnType<typeof reader.read>> to match the actual Cloudflare/Bun reader port rather than the incompatible DOM read-result type. `task-2-purity.log`: `[framework-purity] OK`, exit 0. `task-2-lint.log`: exit 0, no findings, existing multiple-projects resolver informational warning only.

The first typecheck ran from the worktree root and matched other nested workspace/worktrees, producing unrelated missing type-package errors. It was stopped (session 86263), then correctly scoped to vnext. `task-2-root-typecheck-interruption.log` is an explicitly labeled reconstruction of captured tool-output excerpts because the original file was overwritten by the scoped log. These errors do not qualify the current gateway as failing types. No install was performed.

`git diff --check`: pass. `python3 .superpowers/sdd/2026-10-01-resource-capacity-policy/verify-artifact.py protect`: pass before/after commit; `task-2-protection.log` has 38 main / 14 isolated hashes unchanged.

## Limits and concerns

Defaults are provisional engineering policy, not measured CFW-safe limits. Runtime/network/decompression chunks are already created before admission. Reflection, decoded text, JSON expansion, normalization copies, external injected providers and caller-held graphs remain outside raw ingress accounting. Per-reader retained raw blocks are bounded; completed parsing/normalization transients are not an isolate heap ceiling. No retainer budget, replay/cache admission, Chat continuation estimator or diagnostics work was implemented.

Messages and Alpha local calls use standalone per-response caps but do not have hosted Responses/Chat invocation cumulative/operation budgets. Alpha relay/model traffic stays outside the policy. Tests preserve its behavior but do not newly qualify large relay traffic. Failed HTTP error bodies keep their separate existing policy, including prior Jina/Copilot behavior.

No full CI, network/production access, push, deploy, install, service changes or benchmark was performed. Root owns independent review, final combined CI/freeze and any eventual release qualification.

## Fix round 1: retain all started page helper settlement

Status: DONE. Reviewed finding in `task-2-review.md` Important section in full.
Base: `c81e46399624844d7eac5eea828e5bb23392a24e`.
Fix commit: `cf3eb4b2224115ec8392d89dfabff58be0b7d338`.

The finding is confirmed: rethrowing reader capacity from a Jina/Microsoft page helper made Promise.all reject while a started sibling fetch/helper could still be pending. The provider-plus-usage leaf then retired too early. Both page aggregates now use Promise.allSettled and reconstruct fulfilled outcomes in their original URL order only after every helper has settled. A rejected helper rethrows its original reason. The existing ingress latch still aborts the scope and rejects downstream delivery promptly before that aggregate settlement. Ordinary per-page failure values, retry logic, fanout and usage-finally ownership were left intact.

Exactly three source/test paths were committed:

- `vnext/packages/gateway/src/data-plane/tools/web-search/providers/jina.ts`
- `vnext/packages/gateway/src/data-plane/tools/web-search/providers/microsoft-grounding.ts`
- `vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts`

Four real built-in plus real SQLite-backed scope regressions cover each provider with a sibling fetch that resolves or rejects only after an explicit gate. Tests first confirm both fetches started, then observe the original responseBodyBytes capacity reason through immediate delivery rejection. With the sibling fetch still pending, scope.settled remains pending and no engine usage row exists. After releasing/rejecting that fetch, settlement completes and exactly one aggregate engine usage attempt is written by the existing finally path; subsequent delivery still rejects with the same reason. This preserves the existing usage recording semantics (the preexisting recorder emits one aggregate attempt, despite the fetch-page comment's per-URL wording); no telemetry counting change was made.

RED before the aggregate production change:

```sh
bun test vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts --test-name-pattern 'page capacity keeps real'
```

`task-2-fix1-red.log`: 0 pass / 4 fail / 33 filtered out, 20 assertions. All four fail because settled is already true while the sibling fetch has not ended. The original capacity delivery assertion passes before each failure. An initial GREEN fixture then referenced a nonexistent requests column in the general usage table; after inspecting usage.ts it was corrected to the actual engine table and SUM(attempts). This fixture correction does not change the RED discrimination; RED fails earlier on the premature settled assertion.

Final covering GREEN (no broader suites run):

```sh
bun test vnext/packages/gateway/tests/data-plane/tools/web-search/{providers,execution-scope}.test.ts
```

`task-2-fix1-green.log`: 75 pass / 0 fail, 241 assertions, 2 files, 6.46s. Includes the four delayed built-in fetch regressions and existing provider normal/failure/retry and scope normal/cancellation/usage tests.

Necessary scoped checks from worktree/vnext:

```sh
bun run --filter '@vibe-llm/gateway' typecheck
bun scripts/check-framework-purity.ts
bunx eslint packages/gateway/src/data-plane/tools/web-search/providers/{jina,microsoft-grounding}.ts packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts
```

`task-2-fix1-typecheck.log`: exit 0. `task-2-fix1-purity.log`: purity OK, exit 0. `task-2-fix1-lint.log`: exit 0 with only the existing multiple-projects resolver informational warning. `git diff --check`: pass. `task-2-fix1-protection.log`: 38 main / 14 isolated files match protected hashes after commit.

No root docs/protected files staged, no broad suites/full CI, no service/install/network/deploy/push changes. Ownership returned to root after this report. The existing Task 2 qualification boundaries remain unchanged.
