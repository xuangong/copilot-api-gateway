# Task 3 implementation report

Status: DONE_WITH_CONCERNS (documented policy/temporary-owner limits; no known implementation blocker).

Base: ea98379a53d9175a0bc3a3f9e2a6d1b707823616
Commit: 0cab1afa66bc60d6ca86ebb28110b4a7f96811f8
Subject: feat(vnext/gateway): bound retained web search state

Only the ten explicitly scoped source/test files below were staged and committed. No protected overlays or documentation files were staged. Source/index ownership is released after this report.

## Behavior

- Added bounded noncloning graph estimation to the existing capacity module. Charges strings/keys 32 + 2*length, object 64, array 64 + 8/slot, property 16, primitive 8. All own data properties, including nonenumerable array length/extensions, are inspected. Symbol keys, accessors, functions, unsupported primitive types, exotic prototypes and active-ancestor cycles fail with the domain's safe typed capacity error. Shared references are traversed/charged independently. Key and value share one 65,536-value traversal ceiling; depth is at most 64. No stringify, graph cloning, freezing or read-time estimation is used.
- The owned retained map performs atomic net replacement, preserves old/unrelated values on rejection, and retires on clear without eviction/refetch. It checks closure and current counters again after reflection, so retirement/reentry cannot publish against stale state. Maps store borrowed values and per-entry charges.
- The default private scope now owns a 64-entry/4-MiB map, including wire item IDs and full original payload extensions. Its synchronous writer signature and existing write-before-completion caller are unchanged.
- Explicit legacy stores remain delegated and externally owned. Their unknown-valued data and historical entries are not shadowed/cleared; they are NOT certified by the default owned-store capacity guarantee. Existing borrowed-store tests remain passing.
- Scope-owned page caching now exposes only get/set/clear rather than requiring a concrete Map. Standalone low-level Map callers remain structurally compatible. Actual URL/title/content graphs are admitted before perUrl publishes page success; fullContentBytes is not authoritative. A typed cache failure calls the existing internal cancel(reason), immediately latching fatal scope failure and closing siblings/new-start gates, while existing work tracking still waits for real provider/usage settlement.
- Chat charges each newly assembled assistant/tool message array and each newly added citation exactly once, before invocation retention/reentry or citation insertion. Initial history and prior generated history are never rescanned/recharged. Original generated call arguments, rendered tool output strings and preserved tool-call/function extension fields are included. Current-turn stream assembly remains outside the retained-continuation claim.
- Tool-call buffering previously discarded unknown fields. A focused RED test demonstrated this; buffering now carries root/function extensions into generated messages and client-call finalization, without changing known id/type/name/argument ownership.
- Responses writer overflow reaches the established response.failed/server_error owner: no overflowing output_item.done, response.completed or further run; final metadata settles. Chat still throws through its established producer/pipeline owner; no successful stop chunk is synthesized.

## Files in the commit

1. vnext/packages/gateway/src/data-plane/tools/web-search/capacity.ts
2. vnext/packages/gateway/src/data-plane/tools/web-search/execution-scope.ts
3. vnext/packages/gateway/src/data-plane/tools/web-search/operations.ts
4. vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload-store.ts
5. vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts
6. vnext/packages/gateway/tests/data-plane/tools/web-search/retained-capacity.test.ts
7. vnext/packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts
8. vnext/packages/gateway/tests/data-plane/orchestrator/server-tools/private-payload.test.ts
9. vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts
10. vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts

## Verification commands and evidence

The following commands ran from F/vnext unless marked otherwise. No services, dependencies, network, full CI, benchmarks, production operations, pushes or deployments were performed.

Initial RED:

```sh
bun test packages/gateway/tests/data-plane/tools/web-search/retained-capacity.test.ts packages/gateway/tests/data-plane/orchestrator/server-tools/private-payload.test.ts packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts
```

Evidence: task-3-red.log: 89 pass, 4 fail, 1 error. The estimator/map import failed because the new capability did not yet exist; existing private replay and Chat tests failed because overcapacity succeeded. The initial page test used ref instead of the protocol's ref_id; this fixture mistake was corrected before GREEN. The initial shell file-write attempt also used root-relative paths while cwd was vnext; it created no files and was corrected. Neither mistake is claimed as capacity evidence.

Extension RED:

```sh
bun test packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts
```

Evidence: task-3-extension-red.log: 45 pass, 1 fail, at the real generated-message assertion for discarded vendor/function extensions.

Final focused suite:

```sh
bun test packages/gateway/tests/data-plane/tools/web-search packages/gateway/tests/data-plane/orchestrator/server-tools/private-payload.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts
```

Evidence: task-3-focused.log: exit 0; 243 pass, 0 fail, 771 expect calls, 10 files, 10.25s. Includes normal mixed operations/same-page reuse, provider body/fallback/settlement contracts, exact estimator/key-value boundaries, count overflow, net replacement, unknown/nonenumerable fields, invalid graphs, depth/visit limits, retirement during reflection, actual normalized page title admission, scope fatal latch, Chat generated argument overflow, excluded history getter, extension identity/content, cumulative rendered outputs/citations, and Responses writer-before-completion lifecycle failure.

```sh
bun run --filter '@vibe-llm/gateway' typecheck
bun run scripts/check-framework-purity.ts
bun x eslint packages/gateway/src/data-plane/tools/web-search/capacity.ts packages/gateway/src/data-plane/tools/web-search/execution-scope.ts packages/gateway/src/data-plane/tools/web-search/operations.ts packages/gateway/src/data-plane/orchestrator/server-tools/private-payload-store.ts packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts packages/gateway/tests/data-plane/tools/web-search/retained-capacity.test.ts packages/gateway/tests/data-plane/tools/web-search/execution-scope.test.ts packages/gateway/tests/data-plane/orchestrator/server-tools/private-payload.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts
```

Evidence: task-3-types.log: exit 0. task-3-purity.log: [framework-purity] OK, exit 0. task-3-lint.log: exit 0; only existing multiple-TypeScript-project resolver advisory. After the final map reentry-counter tightening, gateway types were rerun successfully and capacity.ts scoped lint reran successfully (task-3-lint-final-capacity.log); final focused suite ran against that final source.

From F:

```sh
python3 .superpowers/sdd/2026-10-01-resource-capacity-policy/verify-artifact.py protect
git diff --cached --check
git show --format=fuller --stat HEAD
```

Protection checked before and after commit: {"main_protected": 38, "isolated_protected": 14}. task-3-protection.log retains the check output. Staged diff check succeeded; committed file inventory contains exactly the ten scoped files, 277 insertions and 11 deletions.

## Concerns and exclusions

- Defaults are provisional engineering policy, not measured CFW-safe production values or isolate heap/CPU/latency guarantees. Legitimate unusually large searches can now fail explicitly.
- Borrowed retained graphs must remain immutable after admission. No freeze/clone is introduced. Reflection's own-key list, already-created graphs, provider/store internals, runtime buffers, JSON parse expansion and temporary provider/perUrl maps remain outside these estimates.
- Chat current-turn streamed arguments/text, response identity/usage, the current result assembly, output pipeline and caller-held initial history remain separate temporary/external owners. This admission bounds generated continuation retention/reentry, not arbitrary model-output ingestion or all live memory.
- External legacy stores are intentionally uncertified. Injected providers that build normalized graphs without a successful-body reader remain outside raw HTTP ingress enforcement, although owned page/replay and Chat retention still enforce their policies.
- Unit/caller/lifecycle tests and gateway typecheck/purity/scoped lint passed. No fresh whole-repository CI, local workerd qualification, native transport end-to-end comparison, release-default measurement or deployment was performed; root owns final qualification and independent review.
