# Task 3 independent implementation review

Date: 2026-10-01. Initial review covers the supplied frozen `57a8ec926c29303421e7259e981f69093f55741d..1650ffc41df0f4c49c127d27cfebc896e03b65f8` eleven-file Task 3 change in `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`.

## Verdict and findings

**CHANGES REQUESTED — one verified P2 foreign-history decoder defect.** No additional verified lifecycle, ownership, cleanup, metadata, activation, or type-contract finding was identified in this review. Whole-branch integration/CI remains a separate controller gate.

### P2: Reject sparse foreign arrays before replay

Location at frozen head: `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload.ts:66-67` (`results`), with the same validation pattern at `:51-52` (`queries` and `sources`).

The decoder validates foreign arrays using `Array.every`, which skips missing array entries. Consequently, `results: new Array(1)` passes validation as a typed `WebSearchCallPrivatePayload`. For an `open_page` action, the replay renderer observes a nonempty results array and accesses `results[0].snippet`, which throws because the first entry is absent. A caller-provided legacy unknown-valued store can supply this value directly, so the runtime foreign-input boundary must reject it even though JSON itself does not preserve sparse holes. The specification requires invalid foreign history to use the existing missing-payload replay fallback rather than reach the typed renderer.

One focused reproduction was executed from the isolated `vnext` directory before the fix; it wrote no files and exited 0:

```sh
bun -e 'import { decodeWebSearchPrivatePayload } from "./packages/gateway/src/data-plane/orchestrator/server-tools/private-payload.ts"; import { renderWebSearchCallOutput } from "./packages/gateway/src/data-plane/tools/web-search/operations.ts"; const value = { v: 1, functionCallItem: { type: "function_call", call_id: "call", name: "search", arguments: "{}" }, ir: { action: { type: "open_page" }, results: new Array(1) } }; const decoded = decodeWebSearchPrivatePayload(value); console.log("decoder accepted sparse results:", decoded !== undefined); try { if (decoded) console.log(renderWebSearchCallOutput(decoded.ir)) } catch (error) { console.log("renderer error:", error instanceof Error ? error.message : String(error)) }'
```

Observed output:

```text
decoder accepted sparse results: true
renderer error: undefined is not an object (evaluating 'results[0].snippet')
```

Minimal correction: validate every position in all three foreign arrays, including holes, and add sparse-array fixtures that assert rejection and the existing fallback path. This requires no clone/freeze policy, capacity limit, or replay-format change.

During report completion the working file showed a `for...of` correction, but the controller confirmed that it was uncommitted work in progress. This initial verdict remains bound to `1650ffc41df0f4c49c127d27cfebc896e03b65f8`; the correction is not approved until a supplied fix SHA receives a limited delta review.

## Scope reviewed

Read the complete production portions of `task-3-review.diff`, the actual added/changed test files, `task-3-report.md`, the latest specification private-state section and global constraints, and the latest Task 3 plan and global constraints. Reviewed `server-tool-lifetime.ts`, the lifetime changes in `server-tool-shim.ts`, `private-payload-store.ts`, `private-payload.ts`, the capability types and source-included compile-time assertions, and the web-search typed/foreign replay and renderer paths. The new lifecycle fixtures and decoder/store tests were read in full.

## Contract and quality assessment

1. **The default state is invocation-owned.** The exported default is an owned source descriptor; the Map is allocated only after hosted activation, reused across lazy inner turns, and revoked/cleared synchronously at invocation closure. Default inactive and replay-only paths allocate no scope or abort listener and preserve upstream result identity. No TTL governs the owned active lifetime.
2. **Read and write authority are separated at runtime and in types.** The stable plugin facade exposes only reading, and returns `undefined` after revocation. The materializer receives a typed writer and narrowed slot capability; the outer owner retains closure authority. Typed writer/disposal results are `undefined`, and included type assertions reject async and broad-void substitutions. The legacy borrowed interface retains its prior `void` convention; closing its adapter revokes local access without clearing the caller's external store.
3. **Pending and concrete resources have one owner.** `awaitResult` acquires a resolved provider synchronously inside the promise callback, avoiding an unowned handoff before the next microtask. The active slot is registered before awaiting its next result. Pending reads are rejected on closure; late providers are discarded, and revoked capabilities prevent late private writes or another dispatch.
4. **Closure and cleanup preserve failure facts.** Closure synchronously revokes state and removes the abort listener, then memoizes composite bounded cleanup. An incomplete close is recorded monotonically and causes cleanup rejection rather than being silently treated as success. Outer return/discard propagates that failure. The real ResponsesTurn fixtures inspect `rawCleanupComplete: false` and preserve the original wire failure for slot cleanup rejection and timeout.
5. **Metadata settlement remains once-only.** The shared settlement path preserves the existing same-model identity behavior. Optional resolver failure resolves the binding fallback and does not skip resource cleanup. The tests cover metadata failure and repeated closure paths.
6. **The accepted design boundaries remain intact.** Typed owned values are borrowed references rather than snapshots, and owned reads do not repeatedly deep-decode. Undefined private payloads are not registered. There is no deep copy/freeze, numeric capacity policy, persistence format change, request-outcome owner, or new performance claim. The sparse-array finding concerns only validation at the explicitly foreign legacy boundary.

## Verification evidence inspected

The implementation's existing logs were read; this reviewer did not rerun the already-passed aggregate tests, typechecks, lint, purity checks, CI, benchmark, or deployment. The only executed runtime check was the focused reproduction above.

| Evidence | Observed result |
|---|---|
| `task-3-red-types.log` | Two expected TS2344 contract failures before implementation |
| `task-3-red-lifecycle.log` | Reported six expected lifecycle failures; reviewed relevant original failure output |
| `task-3-focused.log` | 272 pass / 0 fail, 852 assertions across 20 files |
| `task-3-types.log` | Gateway and protocols typechecks exit 0 |
| `task-3-purity.log` | Framework purity OK |
| `task-3-lint.log` | 0 errors / 4 inherited warnings |
| `task-3-protected-hashes.log` | 14/14 isolated and 38/38 main protected files match |

The focused runtime suite includes actual web-search registrations and platform repositories for two hosted turns across chat_completions/messages/gemini without `include`, plus invocation isolation, capability revocation, inactive cost/identity, early and unstarted exit, pending slots and later providers, late/same-tick provider resolution, cleanup incompleteness, metadata exceptions, and existing producer/JSON/terminal/collaboration behavior. The aggregate passing result does not cover the sparse foreign-array case reproduced by this review.

The report transparently records that two runtime-equivalent empty-generator fixture edits and final type-only materializer narrowing followed the aggregate runtime run, with subsequent type/lint checks. The controller owns the final complete CI run. The protection result above is inspection of the implementation's original log, not a new independent Task 3 hash computation.

## Limits and remaining gates

Only this review document was authored. No source, Git, service, credential, deployment, production, or protected-file mutation was performed. The P2 fix needs a limited frozen-SHA delta review; final whole-branch checks remain with the controller. No active-memory bound, measured performance improvement, production incident resolution, or final release readiness is claimed.

## P2 resolution: limited review of `291b078`

Reviewed frozen correction `291b078215abce54d4e50b6ee397f62833ada279`, parent `1650ffc41df0f4c49c127d27cfebc896e03b65f8`, using read-only `git show`. Its exact scope is the decoder and its focused test (two files, 36 insertions / five deletions).

**The initial P2 is resolved at `291b078`. No new finding in this correction.** All three foreign-array validators now iterate with `for...of`, which yields `undefined` for an absent ordinary array entry. The existing string/object predicates therefore reject holes before the typed renderer is reached. Valid dense arrays retain the prior predicates and borrowed-reference identity. No cloning, freezing, numeric limit, or format change was introduced.

The three new parameterized fixtures reproduce sparse `results`, `queries`, and `sources`. They assert decoder rejection, rejection through the actual borrowed legacy-store adapter, the existing missing-payload replay output, and preservation of the caller's stored object reference. The original open-page result hole is included explicitly. These fixtures exercise the contract and the adapter/transform boundary rather than merely asserting the loop's implementation.

Read the appended implementation report and all six `task-3-review-fix-*` logs:

| Evidence | Observed result |
|---|---|
| `task-3-review-fix-red.log` | 5 pass / 3 fail; all three sparse inputs were wrongly accepted before correction |
| `task-3-review-fix-focused.log` | 38 pass / 0 fail, 179 assertions; decoder/store cases and existing private lifecycle suite |
| `task-3-review-fix-types.log` | Gateway and protocols typechecks exit 0 |
| `task-3-review-fix-purity.log` | Framework purity OK |
| `task-3-review-fix-lint.log` | No rule warning/error; existing multiple-tsconfig informational notice only |
| `task-3-review-fix-protected-hashes.log` | 14 isolated and 38 main protected files; no mismatches |

No tests or product checks were rerun during this delta review. No source or index was changed. The initial finding and reproduction above remain as historical evidence, superseded for this P2 by this resolution. The controller separately reported a pending narrow callback-retention correction; that subsequent delta and final integration/CI are not approved by this entry.

## Final callback delta review and Task 3 verdict

Reviewed frozen correction `da6cc3693ff1a64ecb5d9670905f0f713d90d099`, parent `291b078215abce54d4e50b6ee397f62833ada279`, against the supplied `task-3-callback-fix-review.diff`, complete helper, its actual shim registration, appended implementation report, and all six callback-fix logs. Read-only commit metadata confirms exactly the lifetime helper and its three-test file (two files, 71 insertions / six deletions).

**FINAL TASK 3 VERDICT: CLEAN at `da6cc3693ff1a64ecb5d9670905f0f713d90d099`. The initial sparse-array P2 is resolved, and the separately reported direct closure-callback retention edge is removed. No unresolved finding or new finding in either limited correction remains.** This approves the reviewed Task 3 implementation for the controller's final frozen-artifact integration/CI gate, not final whole-branch or release readiness.

The final helper takes the stored callback and sets `onClosed` to `undefined` before invoking it. A callback registered after closure executes directly without being stored. Thus a retained lifetime no longer has the identified `onClosed` edge to the shim's `settleFinalMetadata` closure and merge output. This is a source-level edge-removal conclusion, not a measured garbage-collection, heap, memory-capacity, or performance claim.

Closure publishes its single cleanup Promise before any synchronous state-disposal or callback code can reenter `close()`. A reentrant call returns that same Promise immediately, without repeating disposal, pending-read cancellation, metadata settlement, or resource cleanup. Creating the Promise queues work; it does not run asynchronous cleanup before the following synchronous statements. The owner then marks itself closed, clears the callback field, removes the abort listener, invokes state disposal, rejects/clears pending reads, and invokes the local callback. All synchronous revocation still precedes the queued resource cleanup.

Failure semantics remain explicit: state-disposal and initial close-callback throws record monotonic incompleteness, while queued resource cleanup still runs. Individual resource failures remain converted to `false` and recorded by the unchanged resource owner. Composite cleanup rejects when incomplete, and every later/reentrant close returns that same rejection-bearing Promise. A post-close callback throws directly to its registration caller, as before, without being retained or initiating another disposal. The three tests check reentrant Promise identity and once-only counters, direct post-close callbacks and error propagation, and throwing initial callbacks with once-only resource return and preserved repeated-close rejection.

| Callback-fix evidence inspected | Observed result |
|---|---|
| `task-3-callback-fix-red.log` | 2 pass / 1 expected fail; pre-fix reentrant cleanup Promise identity differed |
| `task-3-callback-fix-focused.log` | 62 pass / 0 fail, 219 assertions across lifetime, private lifecycle, and turn-barrier suites |
| `task-3-callback-fix-types.log` | Gateway and protocols typechecks exit 0 |
| `task-3-callback-fix-purity.log` | Framework purity OK |
| `task-3-callback-fix-lint.log` | No rule warning/error; existing multiple-tsconfig informational notice only |
| `task-3-callback-fix-protected-hashes.log` | 14 isolated and 38 main protected files; no mismatches |

No aggregate or broad tests were rerun for this review. No source or index was changed; only this report was appended. The initial `1650ffc` verdict remains historical and is superseded by the two fixed-SHA entries and this final Task 3 verdict. The controller retains ownership of final whole-branch checks and any later delivery decision.
