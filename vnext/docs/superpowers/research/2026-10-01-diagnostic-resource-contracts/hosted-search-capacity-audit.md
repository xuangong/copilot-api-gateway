# Hosted-search capacity contract audit

Date: 2026-10-01. Read-only source/design audit; no code/index/commit change, test, benchmark, service, network or deployment action. This report is the only authored artifact.

`F` = `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`, verified HEAD `f6797d50a797a2633d60128593861349038f0300`, with the existing unrelated Responses collaboration/protocol overlay preserved. `R` = `/Volumes/Projects/copilot-gateway`, verified clean at `1d7dcd923e260e425120cca0c7a240e93720af27`. References below are relative to those roots.

## Recommendation

The smallest defensible next resource slice is **request-owned, preflight hosted-search operation admission**, before `parseWebSearchOperations` expands arrays and before `planWebSearchCalls` starts provider promises. Keep result-body ingestion and private replay retention as separate contracts. A Map entry/byte cap alone arrives after the important allocations and cannot establish a request memory bound.

Use an explicit invocation-level operation budget shared by every hosted call and every tool-loop reentry. On exhaustion, reject the entire offending function call before creating plans, slots or provider work, and let the existing response error owner end this response. Do not keep reentering the model with arbitrarily many refusal slots: that would itself permit unbounded refusal/output/replay accumulation. Normal admitted fanout and normal tool-loop reentry stay unchanged.

**No production number is justified by the inspected source.** The accepted prior specification explicitly deferred numerical limits until representative resource evidence (`F/vnext/docs/superpowers/specs/2026-10-01-contract-strengthening.md:74`). The existing 30-turn limit, result-count mapping, catalog budget and WebSocket limits are different policies; none is a source for a search operation or replay byte default. This audit specifies an implementation boundary and excess behavior, not a numeric release policy or measured benefit.

## Verified boundaries and gaps

| Boundary | Current facts | Consequence |
| --- | --- | --- |
| Private ownership | Default descriptor opens an invocation-local Map; writes borrow typed references; `dispose` clears it. Only hosted-active work opens a scope. `F/.../orchestrator/server-tools/private-payload-store.ts:85-100`; `F/.../responses/interceptors/server-tool-shim.ts:1188-1200`. | Lifetime is explicit. Live entries and retained bytes have no cap. Removing TTL can correctly retain a long invocation longer than the old five-minute store; lower active heap is not proven. |
| Per-call expansion | `parseWebSearchOperations` allocates one op for every supported/unsupported array position; malformed supported non-arrays and unsupported scalars also create ops. `F/.../tools/web-search/operations.ts:180-257`. | A preflight after parse is already too late to bound this expansion. Unsupported arrays count toward the resource workload too. |
| Plans and start | `splitWebSearchCalls` constructs all ops/plans and argument slices. `planWebSearchCalls` starts page fetches and every plan immediately. Clean search entries combine into one slot, but all queries still run. `F/.../tools/web-search/plan-operations.ts:131-166,190-196`; `operations.ts:548-562`. | Slot count is not query count. A single slot can own arbitrarily many query promises/results. Sequential terminal materialization is not sequential provider execution. |
| Existing loop policy | Responses checks `iterationCount > 30` before planning, then returns a refusal slot. `max_tool_calls` is decremented once per original dispatched function after dispatch and forwarded to the next upstream request. `F/.../responses/interceptors/server-tools/web-search.ts:459-495`; `server-tool-shim.ts:682-690,1054-1062`. | Neither is a local admission ceiling on operations within a call, calls within a turn, or total accumulated refusal items. Do not relabel either as a fanout cap. |
| Search success bytes | The common mapper caps snippets at 2,048 characters after `content.map(...).join(...)`; it does not cap title/URL bytes or enforce result count itself. All query outcomes are retained until `Promise.all`, then flattened. `F/.../tools/web-search/operations.ts:47-51,515-524,557-562`. | Result counts and snippets are not a bound on success-body parsing, temporary joined strings, titles/URLs, or cumulative replay. |
| Provider ingress | Tavily/Jina/LangSearch parse successful responses with `response.json()` and perform whole-array normalization/filtering before final count selection. `F/.../tools/web-search/providers/tavily.ts:127-142`; `jina.ts:229-260`; `langsearch.ts:77-104`. Error bodies separately use an 8 KiB capped reader (`shared.ts:44-95`). | Success-body admission is missing at the ingestion boundary. A post-JSON rejection cannot prevent the original complete parse allocation. Do not claim the error-body cap covers success. |
| Pages | Production page adapters cap returned content at 10,240 UTF-8 bytes, but `truncateUtf8` first encodes the complete string; Jina/MS first `Promise.all` all URL bodies. `F/.../tools/web-search/types.ts:10-14`; `providers/truncate.ts:7-17`; `jina.ts:270-297`; `microsoft-grounding.ts:227-254`. | Output truncation is not peak-memory admission. The MS comment claiming iteration/typical model fanout bounds concurrency (`:21-23`) is not an enforced guarantee. |
| Page-cache retention | Every fetched page is inserted into request-local `session.pageCache`; no cache count/byte cap. `F/.../tools/web-search/operations.ts:269-275,618-625`. | This is a second retained owner, separate from the private Map. Clearing/capping the latter cannot bound this cache. |
| Replay data | Each payload retains canonical per-slot function arguments and the complete IR regardless of `include`. Arguments preserve original raw entry fields, including ignored fields. `F/.../plan-operations.ts:69-89`; `F/.../responses/interceptors/server-tools/web-search.ts:571-619`. | Large ignored fields can survive in the arguments string. One-count-per-entry or snippet-only accounting misses them. |
| Reentry amplification | Each next turn reconstructs input from base input plus all accumulated output; search replay re-renders the private IR into function output. `F/.../responses/interceptors/server-tool-shim.ts:1043-1053`; `server-tools/web-search.ts:386-397`; `F/.../tools/web-search/operations.ts:362-388`. | Retention has a CPU counterpart: previous results are revisited/rendered on later turns. Do not add full JSON serialization or repeated full-graph size scans to every read. |
| Externally injected stores | Legacy stores remain unknown-valued, externally owned and synchronously trusted; the adapter validates consumed replay fields and never clears the external store. TTL compatibility store has only lazy expiry, with a full sweep on each write. `F/.../orchestrator/server-tools/private-payload-store.ts:3-10,38-82`. | A new owned budget cannot truthfully promise to cap external storage, historical external reads, or delegated asynchronous work. Preserve that explicit boundary. |

Path abbreviation in the table: `F/.../tools` = `F/vnext/packages/gateway/src/data-plane/tools`; `F/.../responses` = `F/vnext/packages/gateway/src/data-plane/chat-flow/responses`; `F/.../orchestrator` = `F/vnext/packages/gateway/src/data-plane/orchestrator`.

## Proposed first interface and exact admission behavior

The narrow contract should live beside shared search planning, with a single owner created for the complete hosted invocation. The following is interface design, not implemented code or a choice of defaults:

```ts
interface WebSearchWorkPolicy {
  readonly operationUnitsPerInvocation: number
}

type WebSearchWorkAdmission =
  | { readonly type: "admitted"; readonly operationUnits: number }
  | { readonly type: "rejected"; readonly reason: "operation-capacity" }

interface WebSearchWorkBudget {
  admit(argumentsObject: Record<string, unknown> | null): WebSearchWorkAdmission
}
```

- Charge units using the parser's existing cardinality rules, before allocating its op array: supported arrays charge `.length`, a present supported non-array charges one, unsupported arrays charge `.length`, and unsupported non-arrays charge one. Charge at least one for a malformed/empty call because it still produces a refusal slot. Sparse positions count, matching the parser. Stop once the remaining budget cannot fit; there is no need to inspect every entry or construct the full count after overflow.
- The budget is monotonic for a complete invocation, across all original function calls and all reentries. Successful work is not refunded when its transient promise settles, because its output/private state is still accumulated. A separate in-flight concurrency limiter, if later wanted, must not reuse this accounting.
- Admission precedes `planShimSlots`' existing iteration-cap early return as well: calls that would otherwise produce refusal slots must still consume capacity. Installing admission only inside `planWebSearchCalls` would leave that allocation path outside the contract.
- Admission is atomic for the offending function call. Rejection does not parse, fan out, canonicalize every slot, fetch pages, search, or record provider usage for that call. Previously admitted calls are not retroactively declared unexecuted.
- The common planner must require an admitted decision/token, or combine admission and planning, so callers cannot accidentally call the eager start path before admission. An optional ignored flag on `WebSearchExecutionSession` is insufficient.
- The plugin surfaces a typed `ServerToolCapacityError` to the existing `runMultiTurnLoop` catch. The owner emits its normal failed terminal/error envelope, settles final metadata and closes through `ServerToolLifetime`; it performs no next `run()`. Preserve existing wire `server_error` unless a separately specified public error code is selected. Do not have the budget/store synthesize a competing terminal result or reclassify the outcome as cancellation.
- Scope: the budget limits gateway-created operations/plans/provider starts for this path. It does not bound the already-parsed upstream arguments string/object, generic upstream output size, raw provider success bodies, all request heap, global concurrent requests, or external storage.
- Shared `planWebSearchCalls` also serves Chat Completions (`F/.../chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts:331-347`). Either thread one policy through both real callers with their existing outcome owners, or explicitly qualify only the hosted Responses caller. Do not silently change cross-protocol coverage in the report.

## Separate follow-up: retained replay admission

Once a quantitative policy is qualified, the owned writer can admit exact typed payloads synchronously before `serverToolEndFrames` (`F/.../responses/interceptors/server-tool-shim.ts:933-959`). Suggested interface:

```ts
interface PrivateReplayRetentionPolicy {
  readonly entries: number
  readonly estimatedBytes: number
}
type PrivateReplayWrite =
  | { readonly type: "retained" }
  | { readonly type: "rejected"; readonly reason: "entry-capacity" | "byte-capacity" }
interface OwnedPrivateReplayWriter {
  admitPrivatePayload(itemId: string, payload: WebSearchCallPrivatePayload): PrivateReplayWrite
}
```

Required behavior: count the item ID, canonical arguments, IR actions/results/optional output text and retained extensions; calculate one bounded estimate at write, store the charge with the entry, perform replacement atomically against the old charge, and reset on disposal. Do not clone/freeze or reserialize just to measure. The byte name must explicitly mean an estimate, not V8 heap bytes; trusted producers must not enlarge retained graphs after admission. Structural TypeScript typing and the current `[key: string]: unknown` function-call extension permit extra retained fields, so counting only the renderer's fields cannot honestly bound the retained object graph. A bounded full-graph estimator or a separately approved exact produced-payload contract is required before that stronger claim.

Reject before emitting the new completed item or replaying it. Do not evict any prior live entry or turn a rejected fresh value into `undefined`: the existing missing-payload fallback would otherwise tell the model its completed search disappeared. Rejection is handled by the existing response failure owner, not by the store. No successful completion or continuation is fabricated.

This remains **retention** admission. Search promises start during planning, and their complete IRs can be retained by other slot closures before the sequential writer sees them. The page cache is another owner. The existing lifetime tracks active slot iterators and source producers; provider search promises are not automatically cancellation-owned merely because the Map closes (`F/.../responses/interceptors/server-tool-lifetime.ts:51-78,122-137`; `server-tools/web-search.ts:602-604`). Therefore terminal-write admission cannot be presented as protection against all provider peaks or as cancellation of every eager search on capacity failure.

Keep the legacy injected interface unchanged. If it is bridged to a generalized write result, name that outcome `delegated`, not `retained-within-budget`; a facade cannot certify another owner's allocation. Do not clear/evict foreign entries or add a second shadow store of unknown historical data to imitate a limit.

## Reference use and non-adoption

- R's source-owned `beginAttempt` scratchpad and explicit read/write access remain useful ownership precedents. At this HEAD it clears/reseeds and `structuredClone`s on writes and reads; it has no private entry/byte budget (`R/packages/gateway/src/data-plane/chat/openai-responses/items/store.ts:39-44,160-170`). Do not copy cloning or claim R supplies capacity policy.
- R currently rejects mixed/multiple open/find operations as ambiguous while allowing clean multi-query search (`R/packages/gateway/src/data-plane/chat/openai-responses/interceptors/server-tools/web-search.ts:668-700`). F deliberately supports those fanouts. Importing R's rejection is a behavior rollback, not a resource contract implementation.
- F's existing `CatalogRetention` is a useful example of owner-held charges and bounded non-stringifying estimation (`F/vnext/packages/gateway/src/data-plane/providers/catalog-retention.ts:12-51`). Its eviction semantics and numeric defaults must not be copied: an evicted catalog can be request-local, while lost live private replay changes the next tool turn.

## Review/qualification targets for the later implementation

No checks below were run in this audit. A later implementation should demonstrate: one-unit/exact-boundary admission; many search queries in one slot; mixed/unsupported/sparse arrays; no op/slot/provider allocation for a rejected call; monotonic budget across multiple function calls and reentries; no next run after capacity failure; native JSON and existing completion/metadata/cleanup behavior; normal fanout and same-response replay unchanged; no accidental external-store ownership. Retention qualification additionally needs atomic replacement/rejection, hidden extension accounting, immediate release, late resolution, and proof that lost payload never silently falls through the history-miss path.

Resource claims must remain specific: source establishes missing contracts and allocation opportunities, not safe numeric throughput, lower CFW heap, lower CPU, production effectiveness, or a global bound.
