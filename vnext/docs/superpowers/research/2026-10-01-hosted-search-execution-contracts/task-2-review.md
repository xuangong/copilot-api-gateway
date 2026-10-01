### Spec Compliance

- **FAIL — one verified delivery-after-close race remains.** `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/web-search-result-owner.ts:135` awaits the guarded read but then returns its step without checking that the owner is still open. Closure between the wait promise's resolution and this continuation can publish a success frame after cancellation, violating Task 2's explicit prohibition on terminal success after close. See Important I1.
- All ten planned source/test files are present in the review package. The optional narrow Chat helper is 147 lines; the old unowned planner export is removed at `vnext/packages/gateway/src/data-plane/tools/web-search/plan-operations.ts:196` (former adapter after `runWebSearchCallPlan`). No capacity policy, configuration, migration, retry change, clone/freeze, or protected attempt/registry edit appears in this task diff.
- **Cannot verify from this task diff:** final frozen-source full CI, remote/production behavior, detached provider cancellation, and measured CPU/memory/latency improvements. These are explicitly outside this task's validation; none is claimed as demonstrated here. The protected-file check is recorded in `task-2-final-protect.log:1` (38 main, 14 isolated); I did not rerun it or independently inspect index/HEAD.

### Strengths

- The capability remains narrow and synchronously cancellable: `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/types.ts:65` defines `ServerToolHostedWork`, and the source type assertion excludes async cancellation. `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime.ts:181` keeps invocation close/adoption out of the slot view.
- Responses adopts work immediately after registration, before later validation/preparation (`vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts:1131`). Invalid requests and conflicts close adopted work, while the exception path at `:1291` preserves the original failure. The non-event result path at `:1231` likewise preserves the already-decided result.
- Work cancellation is synchronous and isolated per callback (`vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime.ts:53`, `:63`, `:147`). Real settlement is observed with the existing bounded cleanup primitive; a timeout does not resolve the search scope's receipt. Coverage at `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts:410` and `:436` checks throwing cancellation and unfinished settlement.
- Responses constructs slot IDs and canonical replay metadata before `batch.start()` and routes each slot through owned result access (`vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts:491`, `:583`, `:614`, `:637`). The actual registration tests exercise eager work before slot acquisition and no late private writes/reentry (`vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts:369`); actual fanout tests additionally cover preparation failure before provider start and an unconsumed rejected branch with a still-pending page sibling (`vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-fanout.test.ts:162`).
- Chat owns the first/later factory before exposing delivery and disposes late results without pulling them (`vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/web-search-result-owner.ts:89`). Concrete current producer cleanup is idempotent, and natural drain avoids forced body disposal (`:46`). Existing producer validation and bounded cleanup primitives remain in their established owners.
- Both native JSON paths use the existing protocol adapters in the new tests: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts:549` and `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts:453`. Their assertions cover citations/summed usage and private replay/final metadata respectively. Existing fanout, client handoff, turn-budget, failed/incomplete, and producer-domain tests remain green in the recorded focused run.

### Issues

#### Critical (Must Fix)

- None found.

#### Important (Should Fix)

- **I1 — `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/web-search-result-owner.ts:135-137`: recheck closure after the outer read await.** `wait()` checks `closed` while settling its own promise. An asynchronous continuation is a later microtask, so that check does not cover the final `return step`. A close queued after `wait`'s callback but before `wrap().next()` resumes sets `closed`, cancels search, and starts cleanup; nevertheless the pending outer `next()` resolves to `{ done: false, value: ... }`. A terminal frame can therefore escape after `discardProducer`/abort has revoked delivery.
  - **Focused probe:** one read-only `bun --eval` invocation imported the actual new helper. A real async generator yielded `"terminal success"`; its next-promise reaction queued `owner.close()` between the helper's wait settlement and outer continuation. A minimal structural search scope recorded synchronous cancellation. Observed output was `{"delivered":{"value":"terminal success","done":false},"cancelledAtDelivery":true}`. This is a deterministic helper-boundary reproduction, not a claim of a full HTTP/transport reproduction. No test suite was rerun and no probe file was created.
  - **Fix:** call `this.assertOpen()` immediately after `await this.wait(generator.next(value))`, before handling `step.done` or returning the step. Add a focused regression that schedules discard/abort in this settlement-to-continuation window and expects no success delivery. Existing pending-read tests close before the underlying operation resolves and do not exercise this distinct window.
  - **Exact probe command**, run from `vnext/`:

    ```sh
    bun --eval 'import { ChatWebSearchResultOwner } from "./packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/web-search-result-owner.ts";
    let cancelled = false;
    const search = { assertOpen() { if (cancelled) throw new Error("closed"); }, cancel(): undefined { cancelled = true; return undefined; }, settled: async () => {}, prepare() { throw new Error("unused"); } };
    const owner = new ChatWebSearchResultOwner<string>(search);
    const generator = (async function* () { yield "terminal success"; })();
    const next = generator.next.bind(generator);
    let closing: Promise<void> | undefined;
    generator.next = (...args) => { const step = next(...args); void step.then(() => queueMicrotask(() => { closing = owner.close(); })); return step; };
    const result = await owner.wrap(generator).next().then(step => ({ delivered: step, cancelledAtDelivery: cancelled }), error => ({ error: String(error), cancelledAtDelivery: cancelled }));
    await closing;
    console.log(JSON.stringify(result));'
    ```

#### Minor (Nice to Have)

- **Inherited validation noise, nonblocking for Task 2:** `task-2-final-lint.log:1` contains the multiple-project resolver advisory; `:4` records `no-useless-assignment` at `server-tool-shim.ts:825`, and `:7` records `require-yield` at `server-tools/web-search.ts:613`. The supplied baseline logs reproduce both warnings (`task-2-baseline-lint-shim.log:4`, `task-2-baseline-lint-web-search.log:4`, former line 602) and the same advisory. This is existing noise rather than a newly introduced defect; no unrelated cleanup or suppression is requested. The final focused test log contains no warnings/errors outside its zero-failure summary.

### Review Scope and Evidence

- Read the provided diff once, in two sequential ranges. No git command, source/index/HEAD change, service operation, installation, network operation, or repeated test suite was performed. Only this report was written.
- **Named risk: adopted work escaping an early Responses return.** The diff cut off the outer function initialization and final catch, so I read the missing `server-tool-shim.ts:1110-1127` and `:1250-1294`. Borrowed dependencies already have a scope; owned dependencies create it for hosted entries in the diff. Any returned hosted work implies a hosted active entry. The normal missing-scope pass-through therefore does not bypass an adopted active work owner. The outer catch closes it on preparation failure.
- **Named risk: bounded cleanup falsely implying real settlement or losing late producers.** The diff cut off supporting lifetime methods, so I read the resource/wait/producer/wrap methods of `server-tool-lifetime.ts`. One focused check of unchanged `shared/producer-ownership.ts:6-37`, `shared/stream-tail.ts:89-107`, and `tools/web-search/execution-scope.ts:42-59,80-111` confirmed existing disposal/deadline behavior, real pending-work accounting, and cancellation of the local scope only. No broader provider/storage crawl was made.
- **Named risk: closure during Chat read publication.** The complete new helper is in the diff. The single probe above resolves this otherwise untested doubt; it is the only executed runtime check.
- Recorded validation was read, not rerun: `task-2-final-focused.log:283-286` reports **252 pass, 0 fail, 712 assertions, 14 files**; `task-2-final-typecheck.log:1` reports exit 0; `task-2-final-purity.log:1` reports OK; lint/protection evidence is triaged above. These runs do not cover I1.

### Assessment

**Task quality: Needs fixes.**

The ownership and preparation changes are narrow, preserve the existing protocol owners, and have substantial actual-caller coverage. The verified final-delivery cancellation race violates the central contract and needs a small guard plus regression coverage before this task can pass.
