# Hosted-search execution ownership audit

Date: 2026-10-01. Read-only architecture audit against `F = /Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`, refreshed HEAD `db9ce4f35abab6fbed34dc038d1efd2c979cf773`. Existing Responses collaboration/protocol working-tree changes were present and were not edited. This report is the only authored artifact. No tests, benchmarks, installation, network, services, index or Git mutations were performed. The reference checkout was unnecessary and was not used.

This follows `vnext/docs/superpowers/research/2026-10-01-diagnostic-resource-contracts/hosted-search-capacity-audit.md` and `resource-contract-followup.md`; their capacity findings are not repeated here. All source references below are relative to `F`. For brevity, `G` means `vnext/packages/gateway`, `S` means `G/src/data-plane/tools/web-search`, and `C` means `G/src/data-plane/chat-flow`.

## Recommendation

Implement one invocation-owned **search execution scope**, shared across every hosted call and reentry, with an explicit pure prepare / owned start boundary. Keep all currently valid operations and normal concurrency. The scope owns a local abort controller, immediate rejection observation for every started task, cancellation-aware result delivery, all-started settlement, and page-cache retirement. Both real callers must wire this scope into their existing result lifetime; a new helper used only by tests would not establish the contract.

Do not add a numeric operation budget, queue, concurrency limit, result cap, refusal policy or retry policy in this increment. Existing source justifies ownership and cancellation semantics, not a new resource quota. The previous capacity proposal remains a separate policy decision. This increment must not claim a heap, task-count, CPU or request-duration bound.

The essential guarantees are:

1. Preparing plans starts no provider work. Starting requires a live owner and can happen only once for that prepared batch.
2. Start preserves the current eager fanout, batching, order, IDs and replay argument slices. Every started asynchronous branch immediately has success and rejection observation, even if its slot is never consumed.
3. Close synchronously forbids further starts, aborts the scope's signal, revokes result delivery and cache writes, clears owned cached pages and unlinks the downstream listener. It does not decide the request outcome.
4. Every started provider operation remains observed through its real settlement, including usage finalization. Delivery may stop promptly on cancellation without pretending that the underlying operation settled.
5. The existing Responses and Chat Completions completion/error owners remain authoritative. Neither execution nor cleanup emits completion, failure, refusal, usage chunks or continuation state.

## Existing semantic policies to preserve

| Existing source | Established meaning | Consequence for this increment |
| --- | --- | --- |
| `S/shim-tool-schema.ts:23-25`; `S/plan-operations.ts:131-155` | The advertised tool explicitly supports parallel operations. Valid searches combine into a native multi-query action; other operations retain separate plans. | Do not serialize plans, reject mixed/open/find fanout, or use slot count as query count. |
| `S/plan-operations.ts:158-166`; `S/operations.ts:638-691` | Page fetches deduplicate within a function call and reuse the invocation page cache across reentries. | Keep batching and cache reuse until the invocation closes. Do not create a new cache per batch. |
| `C/responses/interceptors/server-tools/web-search.ts:459-495` | Responses stops executing search after iteration 30 and returns the existing refusal slot; subsequent model reentry remains possible. | Retain this behavior. It is not invocation operation admission. |
| `C/responses/interceptors/server-tool-shim.ts:682-683,1054-1062` | `max_tool_calls` decrements once per original dispatched function and is forwarded to the next request. | Do not reinterpret it as a plan/query/concurrency cap. |
| `C/chat-completions/interceptors/with-chat-completions-web-search-shim.ts:62-68,315-348,359-384` | Chat executes four search turns, then feeds a budget error for one final answer turn. A client tool call hands control back. One original call gets one concatenated tool message. | Preserve those turn, handoff and output rules. |
| `S/key-config.ts:171-205` | Engine fallback advances on ordinary exception, provider error or empty result. | Keep normal fallback. Cancellation is the missing exit condition, not a new fallback policy. |
| `S/types.ts:30-32,58-61`; `src/data-plane/shared/abort.ts:3-12` under `G` | Provider requests already carry cancellation; propagated abort is intended to stop control flow/backoff. | Local ownership plus guards strengthen an existing contract. Exception names alone cannot enforce it. |
| `S/operations.ts:28-51`; `S/types.ts:10-14` | Result-count/context mapping, snippet and page-output shaping already exist. | None supplies a task quota or settles pending work. |
| `vnext/docs/superpowers/specs/2026-10-01-contract-strengthening.md:68-74,80-83` | Preserve native JSON, lazy output, current completion owners and reentry; explicitly defer new numerical capacity policy. | Apply ownership without changing public protocol behavior. |

## Verified ownership gaps and exact paths

### 1. The public planner starts work before the caller owns it

`S/plan-operations.ts:190-196` calls `splitWebSearchCalls`, starts page fetching, then calls `runWebSearchCallPlan` for every plan. There is no cancellation guard, single-start token or settlement handle. `splitWebSearchCalls` itself is already a usable pure preparation boundary (`:124-155`); a new parsing language is unnecessary.

The fine-grained timing matters: multi-query search starts after its own provider resolution (`S/operations.ts:548-557`), while every single-operation plan awaits the common page-fetch promise before executing (`S/plan-operations.ts:180-186`). Preserve this behavior unless a later change explicitly revisits it; this audit is not proposing a scheduling optimization.

The only production callers of this planner found are Responses `server-tools/web-search.ts:490` and Chat Completions `with-chat-completions-web-search-shim.ts:347`. Alpha search is a separate direct caller of the shared primitives: `G/src/data-plane/alpha-search/routes.ts:186-197` constructs `WebSearchExecutionSession`, awaits `startBatchFetch`, then uses `Promise.all` over `executeOperationToText`. Preserve those exports and that direct API. The new owned-start guarantee covers the two hosted planner callers, not every operation exported by this directory.

### 2. Responses can abandon eager tasks before creating any slot iterator

The dispatcher starts the whole batch at `C/responses/interceptors/server-tools/web-search.ts:568-569`, then builds slots whose generators only await their promise at `:602-603`. Dispatch occurs during upstream `output_item.done`, before the turn has finished, at `server-tool-shim.ts:674-690`. The slot promises can therefore run while the caller is still consuming/yielding start frames.

Only later, and sequentially, does `materializeServerToolItems` acquire a slot iterator and register it with `ServerToolLifetime` (`server-tool-shim.ts:933-959`). Return/discard/stream error before that point leaves all eager provider tasks outside that resource set. While the first slot is pending, later slots are still eager but not iterator-owned. Closing an active iterator does not cancel or settle the promises of those later slots.

The lifetime does close the private store, pending reads, source producers and active slot iterators (`server-tool-lifetime.ts:51-78,122-137`). Its current synchronous state callback only disposes the private store (`server-tool-shim.ts:1114-1116`), and search receives the external downstream signal (`:1124`; `server-tools/web-search.ts:553`). Explicit `return()`, `throw()` or `discardProducer()` closes the invocation without necessarily aborting that external signal. Consequently, production HTTP work can continue after invocation closure, including later query start after page fetching finishes.

These are source-established unowned tasks. An unhandled rejection is additionally possible if an unconsumed plan rejects: no rejection reaction is attached until `slot.run()` is pulled. Built-in adapters commonly turn transport aborts into ordinary result errors, and production `getProvider` is currently an already-resolved promise (`server-tools/web-search.ts:540-549`). Therefore this audit does **not** claim a runtime reproduction of an unhandled rejection on the normal built-in path, or a proven permanent memory leak. It establishes a missing ownership/observation contract and a concrete rejection hazard at the injected provider boundary.

### 3. Chat observes top-level rejection, but has no search/result abandonment owner

`C/chat-completions/interceptors/with-chat-completions-web-search-shim.ts:346-348` immediately feeds all plans to `Promise.all`. Unlike Responses' deferred slot await, this observes each plan rejection immediately. Do not call those top-level promises unhandled.

However, `Promise.all` is fail-fast and does not cancel siblings. The returned result replaces only `events` with a bare async generator and inherits the first producer's discard callback (`:226-233`). The loop has no closing `finally`, owned cancellation controller, or pre/post-await closed guard (`:236-385`). A generator `return()` queues behind an outstanding `next()` that is waiting for search; `discardProducer()` does not itself own the search execution or the current later producer. Later upstream results are reduced to `next.events` (`:376-384`), so the result-level discard capability still refers to the first result.

If a provider returns an error or late success after downstream abort, the loop can still build tool messages and call `run()` (`:349-376`). In the real route an aborted transport signal may prevent new network I/O, but the search loop still invokes the next attempt; source alone does not show that a remote request succeeds. The contract should prohibit this invocation entirely after closure.

### 4. Provider resolution and fallback can start work after cancellation

`S/operations.ts:540-544,553-557,578-590` awaits provider resolution and then starts search/page work with no fresh signal/owner check. Even an already-resolved promise creates an asynchronous continuation; cancellation between preparation and this continuation is meaningful. Existing `getProvider` signatures also permit genuinely deferred resolution.

The built-in provider signal pass-through does not fix fallback. Jina search catches abort into `type: 'error'` (`S/providers/jina.ts:261-266`), and its reader catches abort into a per-URL failure (`:176-180`). Tavily has equivalent broad catches (`S/providers/tavily.ts:144-150,232-238`). `createFallbackWebSearchProvider` checks no signal before or after each await and catches all thrown errors (`S/key-config.ts:178-205`). It therefore invokes the next configured engine even when the shared request signal is already aborted. This affects real multi-engine resolution (`:249`), not only test injection.

Jina and Microsoft retry loops are signal-aware while sleeping, but execute `doFetch()` before checking signal on each iteration (`S/providers/jina.ts:86-94`; `microsoft-grounding.ts:33-41`). Add a guard immediately before an attempt; retain retry counts, delays and ordinary retry conditions. This closes the cancellation gap between sleep settlement and the next attempt. Do not claim this changes provider quotas or proves remote cancellation.

### 5. Late success can still mutate page cache, and plan settlement is not leaf settlement

`S/operations.ts:590-625` awaits provider work plus usage recording, then maps results and writes `session.pageCache` without a closed check. A provider that ignores cancellation, or a successful fetch followed by pending usage recording when closure occurs, can repopulate an otherwise retired cache. Guard before result normalization/cache writes and before publishing IR.

`runBackendSearchMulti` uses `Promise.all` (`S/operations.ts:557`). It observes query rejections, but its aggregate can reject while other query operations remain pending. Tracking only that aggregate or the top-level plan is insufficient for an all-started settlement guarantee. Own each `searchWebAndRecordUsage` operation and each `fetchPageAndRecordUsage` operation as well as plan/fetch aggregates. Their promises include awaited usage finalization in `finally` (`S/search.ts:13-24`; `S/fetch-page.ts:13-27`). Do not skip or detach billing records for calls that already started. A pre-start cancellation must call neither provider nor usage wrapper.

Jina/MS page adapters already await all per-URL outcomes, whose local catches convert failures into values. No scheduler rewrite is needed for those internals. The ownership scope cannot certify unknown detached tasks inside an externally supplied provider.

## Proposed minimal API and behavior

Keep the pure planner and introduce a concrete scope beside `plan-operations.ts`. The following names are illustrative; they describe capabilities, not an implementation mandate:

```ts
interface PreparedWebSearchBatch {
  readonly plans: readonly WebSearchCallPlan[]
}

interface StartedWebSearchCall {
  readonly plan: WebSearchCallPlan
  result(): Promise<WebSearchCallIR>
}

interface StartedWebSearchBatch {
  readonly calls: readonly StartedWebSearchCall[]
}

interface WebSearchExecution {
  readonly signal: AbortSignal
  assertOpen(): void
  start(batch: PreparedWebSearchBatch): StartedWebSearchBatch
  cancel(): undefined
  settled(): Promise<void>
}
```

- `prepareWebSearchCalls(args)` wraps/reuses `splitWebSearchCalls`; no session/provider argument and no network work. Preserve existing malformed/unsupported IR plans. This is **not** preflight memory admission: parsing and plan allocation remain unbounded.
- `start` is the only exported eager entry for these callers; retire or internalize the old unowned `planWebSearchCalls` path. It validates owner-open and consumes one prepared token exactly once. Do not use a global consumed-token Set; a token/closure-local state is enough. No need to freeze or clone payload graphs. Callers build canonical slot metadata before starting, so a metadata construction failure cannot orphan already-started work.
- A single execution scope is created for each active hosted invocation. It owns the request page cache or receives exclusive disposal authority over that cache. It uses a local `AbortController`, linked once to the external signal, and an explicit already-aborted check. No listener/scope is needed for inactive/native/replay-only Responses paths.
- `start` launches all current branches eagerly. Attach observation in the same turn as each launch, including synchronous factory throws. Use a fulfilled outcome record internally, or a rejection-observed raw promise; never turn rejection into a successful undefined IR. `result()` only exposes the existing success/error when requested, and stops delivery promptly if the owner closes. An unconsumed call must not need `result()` to establish rejection observation.
- Internally give `operations.ts` a narrow tracked-provider-call capability taking a factory. Concretely, a tools-owned `WebSearchTaskTracker` has `run<T>(start: () => Promise<T>): Promise<T>`. Pass it as an optional final argument through existing exported operation primitives; direct callers that omit it keep their present execution API. The owned planner/start implementation always supplies it. Do not add a required field to `WebSearchExecutionSession`, remove Alpha's direct exports, or import a chat-flow lifetime into tools. The owner must check its state immediately before invoking that factory and immediately after provider resolution. Track the complete search/page usage wrapper, not merely the underlying fetch, so actual settlement includes its `finally`. Register query leaf operations individually; retiring a failed parent aggregate must not retire unfinished siblings.
- `cancel()` is idempotent and synchronous: close the admission/start gate, abort the owned signal, clear page cache, reject active delivery waits, remove the external listener and drop unnecessary references. It creates no wire error and does not abort/relabel the external request controller. It is safe on normal resource retirement as well as abandonment; the request's already-decided success remains success.
- `settled()` after cancellation resolves only when every actually started, tracked task has settled. It uses all-settled observation rather than fail-fast `Promise.all`. Remove registrations on settlement instead of retaining an ever-growing invocation history. Normal completed results remain available only as long as their caller/slot needs them. Do not require all siblings to settle before delivering a particular normal result or a failure to the existing protocol owner.
- Guard immediately before provider invocation, after `getProvider`, after provider/usage settlement, before cache writes and before slot/tool-message delivery. Guards inspect owning state/the signal, including custom abort reasons; `isAbortError` alone misses swallowed aborts and nonstandard reasons.
- In `createFallbackWebSearchProvider`, guard before each engine, after its await, and in the exception path before allowing fallback. A result returned after cancellation must not trigger another engine. Guard the built-in retry attempt boundary. Ordinary errors/empty results still follow existing fallback/retry behavior.

### Responses production integration

Keep `ServerToolLifetime` as the outer owner and `materializeServerToolItems` as the slot/output owner. The concrete interface decision is an optional `ServerToolHostedDispatch.work` capability with `{ cancel(): undefined; settled(): Promise<void> }`, plus a `ServerToolLifetime.trackWork(work)` adoption method. The plugin prepares the execution scope once only when `hasHostedWebSearch` is true, returns this capability, and uses its scope for every dispatcher call. The host must adopt it **before the first upstream run**, not when it later pulls the first slot. It neither exposes private replay disposal nor request completion. Returning `undefined` enforces the synchronous cancellation contract against accidentally asynchronous implementations.

Extend the existing lifetime's resource registration to cancel this capability synchronously during `close`, then observe its settlement during asynchronous cleanup. The existing deferred `resource.close()` callback alone is insufficient for the synchronous no-new-start guarantee (`server-tool-lifetime.ts:36-48,125-133`). Preparation rejection, a later registration throwing, and early invalid-request exits must also cancel any already-created search scope; no leaked prepare-time listener. Keep pending prepared work in a small host-owned list until the hosted lifetime adopts it; clear that list on transfer. This is one explicit plugin-work capability, not a replacement plugin execution engine.

The dispatcher retains IDs, per-plan arguments and start frames. Slot `run()` calls the owned result accessor. Final materialization still owns private payload writes and completed output; its current `assertOpen` checks remain. Existing failed/incomplete upstream handling currently materializes dispatched tools (`server-tool-shim.ts:1010-1018`); preserve that behavior while the invocation remains open. Do not cancel all work merely because one search returns an ordinary error IR.

The current final metadata resolver, native source materialization, terminal synthesis and private scope disposal remain in place. Explicit error and abandonment cleanup must close execution even if the terminal frame is yielded but the outer generator is never pulled again; route-level result disposal must remain available before first pull.

### Chat Completions production integration

Create the same execution scope after resolving an active engine. Use a **local Chat Completions wrapper** with explicit `next/return/throw/discardProducer` lifecycle methods outside the generator. Do not relocate/generalize `ServerToolLifetime` in this increment and do not import its Responses module into Chat or tools. Use the existing neutral `closeStream`/producer-disposal helpers for this wrapper's concrete cleanup. Merely adding `finally` inside `driveSearchLoop` does not cover unstarted return/discard or a pending `next()`.

That small wrapper owns the execution scope plus the currently acquired upstream producer, disposes late upstream results, and closes on normal drain/error/return/throw/abort/discard. Preserve the lazy frame pipeline and existing producer validation; no Responses-specific events or second completion mechanism. Replace the stale inherited first-result discard behavior with disposal of the current result. Guard after provider setup, before first/next `run`, after every awaited batch and after every awaited next result. Cancellation cannot append tool messages, emit a successful final turn or start another upstream attempt.

Both the stream and native JSON paths continue through their existing adapters. Chat native JSON already becomes frames at `C/chat-completions/attempt.ts:227-243`; retain that path. Responses native activation remains unchanged (`C/responses/interceptors/server-tools/web-search.ts:511-516`); only translated sources satisfying the existing flag/tool checks activate this shim.

### Cleanup settlement and noncooperative providers

Do not add a search runtime deadline under the name of cleanup. `C/shared/stream-tail.ts:7,87-106` already establishes a 1,000 ms **cleanup wait** for iterator/body/metadata resources. If search settlement is adopted as another resource of those same caller lifetimes, that existing wait policy can bound how long close waits, while reporting incomplete cleanup. It cannot make `settled()` true early, be reused as a normal search timeout, or establish a provider/network cancellation guarantee.

Attach observation immediately and keep it attached even if the caller's bounded cleanup wait expires. Never report timeout as successfully stopped work. A provider or usage repository promise that never settles cannot be forcibly settled by JavaScript; its own closures/resources may remain retained. Revocation can still prevent late cache/output writes, fallback and reentry. Report this limit explicitly. No use of `waitUntil` is required to disguise missing ownership.

## Minimal meaningful verification for implementation

These are proposed tests; none was run in this audit. Use deferred providers and existing injected real platform fixtures, not wall-clock benchmarks or `mock.module`.

1. **Pure prepare and one start:** prepare mixed search/open/find/unsupported/malformed calls with zero provider invocations; starting twice or starting after cancel invokes no additional provider/usage work. Keep existing split/argument/action fixtures in `G/tests/data-plane/tools/web-search/plan-operations.test.ts`.
2. **Preserved concurrency:** one multi-query plan plus page plans starts every expected query/page batch without awaiting earlier result delivery; shared URLs fetch once; result order/actions/argument slices match current fixtures. No sequentializing await hidden in `start`.
3. **Deferred provider resolution:** cancel before the deferred `getProvider` resolves; then resolve it. Assert zero search/fetch and zero usage wrapper invocation. Cover already-aborted input too.
4. **Every eager task observed:** make an unconsumed later Responses plan reject while an earlier slot remains pending and abandon the outer response before materialization. Assert no unhandled rejection, synchronous scope abort, no private writes, no completed tool item and no next `run`. Use real hosted registration with controlled provider/fetch behavior; existing fake-slot lifecycle tests do not exercise this gap.
5. **All-started settlement:** one query fails while its sibling provider or usage finalizer remains pending. Cancellation/delivery may finish promptly, but scope settlement must remain pending until the sibling settles; a late success cannot repopulate cache. Include a never-settling fixture only for incomplete-cleanup behavior, with the existing cleanup bound.
6. **Real fallback abort:** configure two engines; first aborts by returning its adapter's ordinary error envelope, and separately by rejecting with an abort reason. Assert the second engine is never invoked. Ordinary error/empty still falls back. Verify abort after retry sleep does not begin another attempt and unchanged normal retry counts.
7. **Both caller lifetimes:** exercise unstarted return/discard, abort during batch wait, early stream failure after dispatch, later producer resolution after close, and normal drain. Check disposal of the current producer exactly once, listener removal, no reentry after closure, unchanged error/cancel classification, and existing metadata settlement. Chat must not merely inherit first producer disposal.
8. **Protocol regressions:** retain Responses multi-turn private replay without `include`, fanout/call IDs, native inactive path and native JSON/producer-domain coverage; retain Chat concatenation/citations/usage, client-tool handoff, four-search-turn budget and final answer turn. Existing real translated-source replay tests are at `G/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts:96-122`; current pending-slot/late-provider tests at `:172-218` mainly cover synthetic slot/upstream producer lifetime, not eager search leaves. Chat budget evidence is `G/tests/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.test.ts:314-345`.
9. **Alpha direct compatibility:** retain local Alpha search/open/find output and existing usage accounting with its unchanged `WebSearchExecutionSession` shape and direct primitive calls. Cover shared signal/fallback guards without claiming that Alpha gained hosted execution-scope ownership.

## Safe implementation split

Use two sequential tasks. First implement the tools-owned preparation/start/scope/tracker contract, cancellation guards and normal fallback/retry preservation, with direct Alpha compatibility. Second adopt that scope in both real callers, add the narrow Responses work hook and local Chat wrapper, and verify the lifecycle/protocol matrix. The first task alone is infrastructure and cancellation-guard strengthening; it is not completion of hosted ownership until both production caller paths adopt the scope. No diagnostic implementation is part of either task.

## Scope and delivery risks

- The difficult part is lifecycle wiring, not splitting the pure planner. A scope created but adopted only at slot materialization leaves the main gap intact.
- Observing only plan/`Promise.all` aggregates proves too little; include query leaf and usage-finalization settlement without changing ordinary billing.
- A broad provider-catch rewrite is unnecessary for this slice. Signal guards at invocation/result/fallback/retry boundaries handle built-in swallowed aborts while preserving ordinary failure IRs.
- Closing search resources must not classify internal failure as downstream cancellation, overwrite a completed response, clear external replay stores, or create another continuation/metadata owner.
- Preserve protected working-tree overlays. Any integration with attempt/registry code should be designed around their current producer APIs rather than editing those unrelated files.
- Capacity admission, provider success-body ingestion, replay-byte limits, page-cache count/byte policy, global concurrency and representative workerd qualification remain separate. Cache retirement improves ownership only; no lower peak heap or CFW production benefit was measured here.
