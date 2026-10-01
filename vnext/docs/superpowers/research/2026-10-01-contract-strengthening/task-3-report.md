# Task 3 implementation report

- Base: `57a8ec926c29303421e7259e981f69093f55741d`
- Commit: `1650ffc41df0f4c49c127d27cfebc896e03b65f8`
- Subject: `refactor(vnext): scope hosted tool private state ownership`
- Scope: exactly 11 Task 3 source/test files. No protected overlay, registry, attempt, documentation or unrelated work was staged. Index is empty after commit.

## Changes

The default private dependency is now an owned source descriptor. Its Map is allocated once only after hosted activation, survives every lazy inner turn, and clears synchronously on invocation closure. Inactive and replay-only default invocations allocate no scope, add no abort listener, and preserve upstream result identity. Explicit legacy unknown-valued/TTL stores remain available; borrowed adapters close their local access without clearing the external store.

The existing v1 search shape is named and re-exported from the original plugin entry, including the function-call extension index signature. The foreign replay boundary validates consumed function/action/result/output fields and preserves reference identity; invalid data uses the existing cache-miss replay. Owned typed reads do not repeatedly deep-decode. Plugins receive a real reader-only facade, materialization receives the typed writer and a narrowed slot-lifetime capability, and only the outer owner can close the invocation. Undefined private payloads are never registered. Typed writes/disposal return `undefined`; source-included compile-time assertions reject async or broad-void substitutes.

The lazy owner tracks pending provider handoff, the concrete current raw/source iterator, active slot iterator, and outer iterator. Provider resolution registers ownership synchronously before handing the result to a later microtask. Return/throw/discard/abort work before first pull and during pending reads; late provider results are discarded, and late slot completions cannot write or dispatch another turn. State revocation precedes bounded cleanup. Cleanup incompleteness is monotonic and remains visible through repeated outer return/discard and the existing ResponsesTurn facts. Metadata settlement is shared and once-only, keeps the existing same-model identity rule, and resolves a binding fallback even if an optional resolver throws; resource cleanup still proceeds.

## Verification

Observed RED before implementation:
- `task-3-red-lifecycle.log`: 3 characterization passes, 6 expected lifecycle failures (cross-invocation default state, borrowed reader authority/lifetime, four unstarted exit paths).
- `task-3-red-types.log`: two expected gateway type failures for plugin write authority and unknown terminal payload.

Final focused runtime command (from isolated `vnext`):
```sh
bun test packages/gateway/tests/data-plane/chat-flow/responses/interceptors packages/gateway/tests/data-plane/chat-flow/responses/respond-json.test.ts packages/gateway/tests/data-plane/chat-flow/responses/turn-barrier.test.ts packages/gateway/tests/data-plane/orchestrator/server-tools/private-payload.test.ts
```
Result: **272 pass, 0 fail, 852 assertions, 20 files**, in `task-3-focused.log`. This includes existing producer-domain, JSON, terminal barrier, hosted identity, web-search activation/fanout, and collaboration suites. New tests use real web-search registration and platform repositories for two hosted search turns across chat_completions/messages/gemini without `include`. Other cases cover concurrent/equal ids, foreign replay validation, capability closure, inactive costs, early failure, unstarted exit, pending slots/current later producer, late/same-tick provider resolution, disposal exceptions, and metadata exceptions. Slot cleanup rejection and timeout are exercised through real ResponsesTurn facts with `rawCleanupComplete: false`, retaining original wire failure.

The last runtime-equivalent fixture cleanup adds `yield* []` to two empty generators; the final type-only materializer capability narrowing also follows that runtime run, as agreed with root. Both are covered by subsequent type/lint checks; root owns the one final complete CI run.

Additional checks:
- `bun run --filter '@vibe-llm/gateway' --filter '@vibe-llm/protocols' typecheck`: both exit 0 (`task-3-types.log`).
- `bun run scripts/check-framework-purity.ts`: OK (`task-3-purity.log`).
- `bun x eslint` on all 11 changed source/test files: exit 0, **0 errors / 4 inherited warnings** (`task-3-lint.log`). Warnings are existing shim line 825 unused assignment; production web-search slot no-yield generator; existing shim test generators at lines 577 and 1018. No new warning or suppression remains.
- `git diff --check` and staged `--check`: clean.
- Post-commit SHA-256 check: all **14 isolated + 38 main** protected files unchanged (`task-3-protected-hashes.log`).

## Boundaries

No full CI, benchmark, install, service restart, push, deployment, or production access was performed. No capacity bound or runtime memory/performance improvement is claimed: lifetime correctness can keep long-running replay payloads alive longer than the old TTL and does not prove a lower active peak. No clone/freeze, numeric limit, persistence/replay format, or request-outcome owner was added. An arbitrarily abandoned reference without drain/return/throw/abort/discard cannot be actively reclaimed by this contract. The legacy void-valued external store remains a trusted synchronous convention; its implementation cannot be proven synchronous by this adapter.

## Independent review follow-up: sparse foreign arrays

- Review finding: P2, `Array.every` skips holes in foreign arrays. A v1 payload with `open_page` and `results: new Array(1)` passed the decoder but could fail when the renderer read `results[0].snippet`. The same acceptance gap existed in search `queries` and `sources`.
- Fix commit: `291b078215abce54d4e50b6ee397f62833ada279` (`fix(vnext): reject sparse private replay arrays`), parent `1650ffc41df0f4c49c127d27cfebc896e03b65f8`.
- Scope: only `private-payload.ts` and its focused runtime test. No root docs, protected overlays, or other files were staged; the task report is appended here without altering the original evidence.
- Observed RED: **5 pass / 3 fail** before the product fix. All three new sparse cases were wrongly accepted (`task-3-review-fix-red.log`).
- Fix: use `for...of` for queries, sources, and results. Array holes are observed as `undefined` and rejected, with no clone, freeze, numeric bound, or valid-reference change. Tests also assert borrowed-store cache miss, existing missing-private-payload replay output, and unchanged external stored reference.
- Focused GREEN: `bun test packages/gateway/tests/data-plane/orchestrator/server-tools/private-payload.test.ts packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts` -> **38 pass / 0 fail / 179 assertions** (`task-3-review-fix-focused.log`).
- Gateway and protocols typecheck both exit 0 (`task-3-review-fix-types.log`); scoped lint on the two changed files exits 0 with no rule warnings/errors (`task-3-review-fix-lint.log`); purity is OK (`task-3-review-fix-purity.log`). The lint tool still prints its repository-wide multiple-tsconfig informational notice.
- `git diff --check` and staged diff check are clean. All **14 isolated + 38 main** protected hashes remain unchanged (`task-3-review-fix-protected-hashes.log`). No full CI or benchmark was run. The existing capacity and abandonment limitations remain unchanged.

## Whole-review follow-up: release the closure callback

- Finding: the completed lifetime retained its `onClosed` callback, whose shim closure reached metadata settlement and the accumulated merge output. The result's events/discard callbacks continued to retain the lifetime.
- Fix commit: `da6cc3693ff1a64ecb5d9670905f0f713d90d099` (`fix(vnext): release hosted tool closure callbacks`), parent `291b078215abce54d4e50b6ee397f62833ada279`.
- Scope: the lifetime helper and one focused test file only. Closed `onClose` registrations invoke directly without storage; `close` takes and clears the callback before invocation. The single cleanup Promise is published before synchronous callbacks, so reentrant close returns the same Promise without repeating state disposal or settlement. Private state still closes synchronously, cleanup remains bounded, callback throws still mark cleanup incomplete, and post-close callback throws still propagate directly.
- Focused regression first observed **2 pass / 1 expected fail** for reentrant closure identity/once-only behavior (`task-3-callback-fix-red.log`). The three tests cover reentrant close, direct post-close callbacks, and throwing callback cleanup/failure retention. No private-field assertion or artificial GC test was added.
- GREEN command: `bun test packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-lifetime.test.ts packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts packages/gateway/tests/data-plane/chat-flow/responses/turn-barrier.test.ts` -> **62 pass / 0 fail / 219 assertions** (`task-3-callback-fix-focused.log`).
- Gateway/protocol types both exit 0 (`task-3-callback-fix-types.log`), two-file scoped lint exits 0 with no rule warnings/errors (`task-3-callback-fix-lint.log`), and purity is OK (`task-3-callback-fix-purity.log`). Diff checks are clean. All **14 isolated + 38 main** protected file hashes match (`task-3-callback-fix-protected-hashes.log`); index is empty after commit.
- This removes the identified direct retention edge; it is not a measured GC, heap, capacity, or performance claim. No full CI, benchmark, install, push, deployment, or service change was performed. Source is frozen for the final independent review and CI owned by root.

## Raw evidence location

Log filenames in this archived report refer to the preserved local worktree directory `.superpowers/sdd/2026-10-01-contract-strengthening/`. Raw logs remain outside tracked product documentation.
