# Hosted-tool private payload contract audit

Date: 2026-10-01. Read-only source/design audit; this file is the only authored artifact. No implementation, tests, probes, benchmarks, dependency installation, restart, deployment, commit, or push was performed.

Inspected `F = /Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix` at HEAD `dbde0567b505267098258fa3293b38ca29d3b27a`. Reference `R = /Volumes/Projects/copilot-gateway` was freshly verified at HEAD `1d7dcd923e260e425120cca0c7a240e93720af27`. The requested starting document was read first: `F/vnext/docs/superpowers/research/2026-10-01-interceptor-contracts/private-state-followup.md`. Findings below were checked against current source rather than adopting its earlier HEAD as current.

## Recommendation

Introduce an owned, typed private scratchpad once inside each active outer hosted-tool shim invocation. Keep it alive through the complete lazy result, including every inner upstream tool turn. Give plugins a reader facade; let the common materializer be the only writer; let the shim result owner be the only disposer. Preserve explicitly injected stores as borrowed compatibility dependencies, with unknown-value validation at that boundary. Keep the protected registry byte-identical: change its existing `defaultPrivatePayloadStore` import to denote an owned factory/source, rather than a process Map, and teach the shim to accept that source alongside a legacy borrowed store.

The smallest current implementation slice is lifetime/authority, typed payload validation, and skipping undefined writes. Count/byte admission and any new overflow outcome remain a separate gate unless their output semantics and numeric policy are deliberately qualified. Do not add durable replay, change native Responses activation, relocate request normalizers, or replace the producer/result model. Those are separate contracts. A default scratchpad miss on historical input continues to use the existing not-preserved notice; a future capacity failure while producing a current search must fail explicitly, never masquerade as a historical miss.

## Verified current gaps

| Boundary | Current source fact | Smallest enforcement |
|---|---|---|
| Lifetime | Registry captures `defaultPrivatePayloadStore`; the implementation is one module-level TTL Map | Keep registry unchanged but make its captured default a factory/source; allocate only for an active hosted invocation, never each `run()` or frame |
| Read/write authority | `ServerToolRequestCtx.store` exposes both `registerPrivatePayload` and `getPrivatePayload` | Plugin context exposes a concrete reader-only object, not merely a cast of the mutable object |
| Payload shape | Terminal payload and store values are `unknown` | Give producer terminals and owned storage one named payload type; retain `unknown` only for foreign replay/legacy reads |
| Runtime shape | Search guard only checks v1, four function-call fields, non-undefined action, and a result array | Validate action discriminants, every consumed string/array/result field, and optional output text before accepting a foreign value |
| Aliasing | Stored and returned values are original references; public search items share IR action/results | Snapshot once on admission and freeze the owned snapshot; return a deeply readonly view |
| Registration | Every terminal registers, including image terminals with `undefined` | Omit registration when no payload exists |
| Retention | Absolute five-minute TTL, sweep on write, no explicit release | Owned active entries have no TTL eviction; release explicitly on terminal cleanup/cancel/discard |
| Capacity | No entry, entry-byte, or response-byte limit | Separate admission gate: atomic finite policy and explicit failure; no eviction of active replay entries |
| Slot cleanup | `materializeServerToolItems` manually calls `slot.run().next()` without a closing `finally` | Track/close the current slot iterator on return, throw, abort, and admission error |
| Unstarted result | `runMultiTurnLoop` has a `finally`, but returning an unstarted async generator does not execute it | Owned result wrapper closes synchronously before delegating `return`/`throw`/discard |

Pointers in F: `orchestrator/server-tools/private-payload-store.ts:21-68`; `orchestrator/server-tools/types.ts:33-45,125-131`; `responses/interceptors/index.ts:76`; `responses/interceptors/server-tool-shim.ts:932-950,1084-1110,1195-1241`; `responses/interceptors/server-tools/web-search.ts:338-355,638-655`. Paths abbreviated above are under `vnext/packages/gateway/src/data-plane/`.

The aliasing observation is concrete: `web-search.ts:644-650` assigns the same `ir.action` and `ir.results` to the public item and private payload. Freezing the original IR would also freeze objects visible to later public-output processing. Clone the known private shape before freezing; do not freeze producer-owned/public objects in place.

## Shape contract

The only data-bearing payload in this store today is the v1 web-search payload. Image generation has public base64 output and no private payload (`responses/interceptors/server-tools/image-generation.ts:1361-1383`); it must not acquire an invented private image shape.

Move the existing v1 payload declaration/guard out of the plugin into a small gateway-owned module, for example `orchestrator/server-tools/private-payload.ts`. Keep the current value shape `{ v: 1, functionCallItem, ir }` and retain `WebSearchCallPrivatePayload` as a type re-export from the plugin for callers. There is no need to add a wire version, durable schema, provider import, or new `kind` field to strengthen the current contract.

Define the function-call shape using the actual fields generated at `web-search.ts:607-622`: `type: "function_call"`, `call_id`, `name`, `arguments`, and optional string `status`. Define the private IR through the already-owned `WebSearchCallIR` shape (`tools/web-search/operations.ts:280-283`), with a deeply readonly stored projection. Its action is the existing `ResponsesWebSearchAction` union and its results are `ResponsesWebSearchResult[]` (`protocols-llm/src/responses/events.ts:456-466`). Do not send protocol-specific storage contracts down into `@vibe-core/*`.

The minimal common terminal change is `privatePayload?: WebSearchCallPrivatePayload`, replacing `unknown`. This closes the arbitrary-object/primitive producer hole without redesigning all plugin item unions. Optionally make `ServerToolTerminal`/`ServerToolResultSlot` generic over their private payload, with web search selecting v1 and image selecting no payload; that is useful only if the resulting descriptor inference remains simple. A broad string-typed item union does not prove that every `web_search_call` carries its payload, so enforce the existing web-search producer's mandatory payload at its own local terminal return type and test it. Do not claim the optional common field alone establishes item/payload correlation.

Use a shared `decodeWebSearchPrivatePayload(value: unknown)` boundary for explicit injected-store reads and future explicit seeds. Validate:

- Literal v1 and function-call type; string call ID, name, arguments; optional string status.
- Action object with the existing search/open_page/find_in_page discriminant and the required/optional strings shown in the protocol union; string query arrays and `{ type: "url", url: string }` sources when present.
- Each result is `{ type: "text_result", url: string, title: string, snippet: string }`; optional `outputText` is a string.
- Data-only traversal before snapshot construction; reject unsupported non-data objects, cyclic values, or malformed entries rather than allowing the renderer to consume unchecked objects. A finite byte/count traversal limit belongs to the separately qualified admission policy, not a hidden new rejection threshold in this slice.

An unknown version or malformed foreign read remains a miss and follows the current replay fallback. A malformed payload produced by an in-process typed plugin is a contract violation and fails that response; it is not a missing-history notice. These are different failure sources.

## Authority contract

Use separate structural capabilities rather than exporting a single object with hidden policy:

```ts
interface ServerToolPrivatePayloadReader {
  getPrivatePayload(itemId: string): ReadonlyWebSearchPrivatePayload | undefined
}

interface ServerToolPrivatePayloadWriter {
  registerPrivatePayload(itemId: string, payload: WebSearchCallPrivatePayload): void
}

interface OwnedServerToolPrivatePayloadScope {
  readonly reader: ServerToolPrivatePayloadReader
  readonly writer: ServerToolPrivatePayloadWriter
  dispose(): void
}

interface OwnedServerToolPrivatePayloadSource {
  readonly ownership: "owned"
  createScope(): OwnedServerToolPrivatePayloadScope
}

type ServerToolPrivatePayloadDependency =
  | OwnedServerToolPrivatePayloadSource
  | PrivatePayloadStore // Existing unknown-valued interface: borrowed.
```

The interfaces are a design sketch, not an implemented API. Only the invocation owner keeps `OwnedServerToolPrivatePayloadScope`. Export `defaultPrivatePayloadStore` with the owned-source type under its existing name so the protected registry import/call stays byte-identical. The shim's second parameter accepts `ServerToolPrivatePayloadDependency`; the `ownership` discriminant selects a source while a legacy `PrivatePayloadStore` remains borrowed. `ServerToolRequestCtx.store` retains its name but changes to the reader interface and receives a stable reader facade. The materializer accepts only the writer interface. Neither receives disposal authority. The default owner is scoped by object construction, so it does not need an API-key field or an empty-string owner namespace to isolate concurrent invocations.

For the default source, prepare registrations with a lightweight reader facade delegating to an invocation-local `scope` variable; before a scope exists its read is a miss. Determine `hostedActive` immediately after preparation and create the scope only when hosted dispatch is active, before the first input transformation. A plugin that captures the facade during preparation therefore sees later writes correctly. The inactive/no-hosted path allocates no Map, owned scope, abort-listener ownership, or event iterator wrapper. A replay-only default path has no seed and remains a miss; an injected borrowed store keeps its replay reads. A small stable reader facade in the already-existing request context is sufficient; do not eagerly invoke `createScope` at interceptor entry.

Snapshot the supported private fields once on registration, freeze the snapshot, then commit atomically; a later admission gate can compute accounted size before this snapshot step. Reads return the immutable view without serializing/cloning the full payload again. A producer retaining its original IR cannot mutate replay data; a reader cannot mutate nested arrays or function-call strings through the typed surface. Avoid an unknown index signature in the stored projection: it would reintroduce arbitrary unbudgeted blobs into an ostensibly typed payload. If preserving extra fields in an explicitly injected foreign payload is required, characterize that compatibility separately; current in-process production constructs only the named fields.

Disposed default scopes reject reads/writes with a named closed-scope error. Returning an ordinary miss after disposal would let stale code silently degrade an active loop. Disposal is idempotent and clears both entry references and accounting. A late provider/slot resolution must not be admitted or forwarded after the owner has closed.

## Lifetime and cleanup contract

### Owner boundary

Create the owned scope after plugin preparation confirms hosted dispatch, before the first input rewrite (`server-tool-shim.ts:1170-1172`). The default has no replay seeds, so preparation-time reads need only return misses through the stable facade; borrowed stores can read immediately. Transfer ownership only when returning the hosted lazy result. All failures/early exits after allocation close the owned scope, including non-event first result and producer validation failure. Invalid registration, no active registration, and default replay-only pass-through must not allocate it in the first place. Do not widen this lazy rule to a hypothetical seeded source without defining when those seeds become visible.

A `finally` around the interceptor function cannot close a returned hosted result, because reads/writes continue during `runMultiTurnLoop`. Conversely, allocating a new store on each loop iteration would lose previous search results. Keep the same scope through the accumulated output rewrite at `server-tool-shim.ts:1023-1050` and every inner `run()`.

### Owned result wrapper

Return a single-consumer owned iterable/iterator that wraps the existing multi-turn generator. Its `next`, `return`, `throw`, abort callback, and result `discardProducer` converge on an idempotent owner close operation. Close the scratchpad and unlink its abort listener synchronously; then perform provider/iterator cleanup under the existing bounded helpers. Do not wait for a blocked `next()` before clearing the map.

Required paths:

1. Natural generator drain: close after the final item/terminal no longer needs replay state and resolve existing final metadata.
2. Explicit `return`/`throw`, including before the first `next`: close immediately and ask the underlying iterator to close.
3. Abort during preparation, first stream, search/image lifecycle, or a later inner `run`: close immediately; late continuations must observe closed/aborted state before another write/run/yield.
4. Rejection before iteration: the composite `discardProducer` closes private ownership and delegates concrete producer disposal.
5. Admission failure: close after emitting the existing failed response path; do not issue the next upstream request.

F already has appropriate vocabulary: `LlmEventResultMetadata.discardProducer` is explicit pre-iteration disposal (`protocols-llm/src/common/result.ts:85-95`); `producer-ownership.ts:29-37` documents the unstarted-generator limitation; `closeStream` bounds `return()` at one second (`shared/stream-tail.ts:87-98`). `responses/turn.ts:294-299,340-346,503-518` wraps raw `return` idempotently and handles pre-consumption cancel. Reuse these contracts rather than adding turn-level persistence or HTTP-specific ownership.

The shim currently returns `...firstResult`, retaining its first `discardProducer`, while later turns are created at `server-tool-shim.ts:1050-1061`. A composite cleanup callback must track the concrete currently owned result/iterator, updated before materializing each later result. Do not close only the first body or claim first-body cleanup proves every later body closed. `abortUpstream` remains the source owner's abort function; private cleanup must not redefine request cancel or telemetry outcome.

`materializeServerToolItems` needs a `try/finally` around each manually driven slot lifecycle and must call a bounded close when it did not reach its natural return. The outer owned wrapper should also know the currently pending slot iterator so abort can request closure even when its `next()` never settles. This is a necessary consequence of placing disposal in a lazy lifetime, not a general image/search redesign.

Scratchpad reference release is provable independently from provider closure. A hostile iterator may time out during `return`; report cleanup incompleteness through the existing owner rather than equating a cleared map with all resources released. Simply losing all references to an iterable without `return`, abort, or discard has no reliable notification mechanism; do not promise deterministic cleanup for arbitrary abandoned external callers. Production consumers must exercise the explicit lifecycle paths.

## Explicit injection and replay compatibility

Keep the current second positional store argument accepted as a borrowed dependency (or provide an overload). Existing tests and direct callers deliberately pass `createInMemoryPrivatePayloadStore()`; this is an actual surface, not a hypothetical API. The production registry stays byte-identical and still passes `defaultPrivatePayloadStore`; that export becomes an owned-source descriptor and creates a fresh scope only for each active hosted invocation.

For a borrowed legacy `PrivatePayloadStore`:

- Do not clear, reseed, dispose, or globally expire it on invocation completion.
- Preserve reads/writes through the supplied object and its own TTL, including conditional direct cross-invocation replay when a caller reuses the object.
- Wrap it with a typed reader/validated admission adapter; plugins never regain its write/dispose methods.
- Skip undefined writes in all modes. Current callers that rely on retaining undefined entries have no data-bearing production path to preserve.
- Stop using the borrowed object after local invocation closure even though its owner may reuse it later.

This mode is explicit external ownership. It does not gain default owner isolation or a global byte bound by passing through the shim. Document that limitation rather than making a false claim that every possible injected implementation is bounded/owner-authenticated. If a new owned factory option is exposed, use a discriminated option such as `{ ownership: "owned", createScope }`, so disposal authority cannot be inferred from the accidental presence of a `clear` method.

Do not automatically seed default storage from the old singleton, caller wire `results`, native Responses snapshots, or unused `responses_items.private_json`. There is no verified production hydration path for this Map. Native Responses search activation is explicitly inactive (`web-search.ts:547-558`). Standard Messages/Chat/Gemini request builders do not construct hosted search replay items; the earlier follow-up traces those paths. Preserve a focused test for direct activated replay with an injected shared store and a separate test that default invocations do not share entries.

An explicit future seed must be supplied by an authenticated source owner, validated before exposure, and admitted under the same capacity policy. A wire ID is a lookup key, not proof of ownership. No seed resolver, D1 writes, anonymous owner namespace, or durable cross-request contract is justified by the current audit.

## Bounds and overflow

This section specifies the next admission gate, not a requirement to invent new limits during the lifetime/authority increment. For that future gate, enforce `maxEntries`, `maxEntryBytes`, and `maxResponseBytes` with finite non-negative policy validation and atomic admission. Reject duplicate current-response IDs rather than silently overwriting an earlier private replay value. Include all retained data in accounting: item key, function-call ID/name/arguments/status, action query/queries/URL/pattern/sources, result URL/title/snippet, and output text. A deterministic UTF-8/structural accounting rule is a storage budget, not an exact JS heap measurement; document the distinction.

Measure once per write with early termination at the entry/aggregate bound. Do not `JSON.stringify` a potentially huge value just to discover it is too large, allocate a full byte buffer for counting, or rescan every live entry at every write. Preserve O(1) aggregate accounting apart from the admitted value's bounded traversal. Stored data remains until owner close; neither TTL nor LRU eviction is safe inside a live response because every earlier search can be re-rendered on later turns.

An admission failure occurs before `serverToolEndFrames`, hence before a completed search item becomes public and before the next input rewrite. Use a named `PrivatePayloadCapacityError` with safe fixed error code/message, caught by the current failed-response envelope path. Do not leak the payload, silently trim historical arguments, emit a successful terminal and later substitute a miss, or continue with incomplete private results. Preserve already emitted unrelated items; the response fails explicitly at the current work boundary.

Store admission alone bounds retained scratchpad data, not all transient search work. `planWebSearchCalls` starts every plan before terminal admission; batched queries use `Promise.all` and concatenate results (`tools/web-search/plan-operations.ts:181-190`; `operations.ts:548-562`). Arguments, number of queries/open/find operations, provider result count/title/URL, page cache, accumulated public output, and pending promises can all grow earlier. If this slice claims a complete resource bound, preflight a finite operation/argument budget before starting fetches and normalize provider results incrementally before building a large aggregate IR. Otherwise describe its result precisely as private retained-state admission and lifecycle cleanup, and leave broader planning/cache limits as a named follow-up.

The exact production budget values are not derivable from source. There are no measured representative payload distributions, concurrent response counts, or heap overhead in this audit. Implementation can use explicit finite conservative defaults with tests at injected small limits, but their release suitability needs qualification. `return_token_budget`, the 30 search iteration cap, and optional `max_tool_calls` are not private-byte budgets.

## What to borrow from R

R's useful pattern is separation of source-owned replay backing and transient attempt state. `items/store.ts:39-44,160-170` clears/reseeds private state at the source attempt boundary, skips undefined writes, and clones values. `items/hydrate.ts:11-45` returns an explicit seed map; `items/output.ts:61-81` attaches private state to the exact owned item row; `items/store.ts:173-179,274-281` looks up rows under API-key identity. Non-Responses sources use a store without backings (`items/store.ts:390-397`); the source context constructs it (`chat/shared/gateway-ctx.ts:7-34`).

Borrow explicit ownership, skipped undefined values, and validated seed/read boundaries. Do not copy R's per-read structured cloning, full persistence machinery, or `beginAttempt` reset call blindly into F's repeated inner tool turns. R remains unknown-shaped at this payload surface and has no proven bound for F. Its pattern is evidence for scope separation, not proof that either implementation already has the strong payload/capacity contract proposed here.

## Proposed implementation files

All production paths below are relative to `F/vnext/packages/gateway/src/data-plane/`.

| File | Planned responsibility |
|---|---|
| `orchestrator/server-tools/private-payload.ts` (new) | Current payload schema, readonly projection, runtime decoder/snapshot helper; no provider/persistence dependency |
| `orchestrator/server-tools/private-payload-store.ts` | Reader/writer/owned-scope/source interfaces, lazy default source, idempotent close; keep explicit legacy factory borrowed and separately documented; admission/accounting is a separate gate |
| `orchestrator/server-tools/types.ts` | Typed terminal payload; reader-only plugin context; local typed web-search terminal optional extension |
| `chat-flow/responses/interceptors/server-tools/web-search.ts` | Import/re-export named payload type; validated replay lookup; mandatory local terminal payload; no activation or wire change |
| `chat-flow/responses/interceptors/server-tool-shim.ts` | Owned default vs borrowed injection; early-exit release; lazy owned result wrapper; slot closure; composite current-producer discard; skip undefined; explicit capacity error path |
| `chat-flow/responses/interceptors/index.ts` | Protected; byte-identical, including existing import and second positional argument |

Do not modify `responses/turn.ts`, protocol result unions, snapshot stores, repository schema, normalizer bodies, or translate request builders merely to implement this scratchpad. If an actual missing lifecycle propagation is discovered by fixtures, identify that narrower dependency before broadening the slice.

## Required characterization and enforcement cases

These are proposed checks, not tests run by this audit.

1. `tests/data-plane/chat-flow/responses/interceptors/server-tool-shim.test.ts`: two hosted search turns plus final assistant; include absent; old private IR restored exactly in both subsequent upstream payloads; same default scope survives all inner runs; first returned event result does not trigger disposal.
2. Same file: default shim reused for concurrent/sequential invocations with the same test item ID has distinct scope; a borrowed injected store retains its entry after drain and supports direct activated replay; native activation remains inactive in existing `server-tools/web-search-activation.test.ts`.
3. Same file or new `server-tool-private-lifecycle.test.ts`: preparation rejection/throw, no active tools, replay-only pass-through, non-event first result, producer validation rejection, natural completed/failed/incomplete drain, return/throw before first next, abort before first pull, abort after private admission, abort during later run, and abort during a never-settling slot. Assert both map release and which specific iterator/body callback was invoked; do not infer the latter from a completion promise alone.
4. Same lifecycle fixture: slot generator finally runs on early return/admission error; a hostile pending next produces bounded incomplete cleanup; late slot resolution cannot register, issue another run, or emit a done item after close; final metadata settles idempotently without using private cleanup to manufacture cancellation.
5. New `tests/data-plane/orchestrator/server-tools/private-payload-store.test.ts`: no undefined entry, fixed count/entry/aggregate limits, exact-boundary acceptance, one-unit overflow, UTF-8 non-ASCII text, atomic rejection, duplicate ID, accounting reset, idempotent disposal, closed read/write failure, source/returned mutation isolation, and large input early-stop accounting.
6. New `tests/data-plane/orchestrator/server-tools/private-payload.test.ts`: full current v1 payload; every action; optional output text; malformed result field/action/array/version; foreign invalid value follows replay fallback while producer invalid value fails the response. Keep the existing fanout expectations in `server-tools/web-search-fanout.test.ts`.
7. New type-contract fixture checked by normal gateway typecheck: plugin reader has no writer/dispose key; materializer writer has no reader/dispose key; primitive/unknown payload is not assignable to terminal private payload; nested stored arrays/fields are readonly. Use type assertions rather than unexplained suppression comments.
8. Existing `interceptors/producer-domain.test.ts`, `shared/producer-cleanup.test.ts`, `responses/turn-barrier.test.ts`, `responses/respond-json.test.ts`, and collaboration suites: producer domain and JSON semantics stay intact; cancellation before iteration still reaches explicit disposal; terminal cleanup does not break continuation/settlement ordering.
9. Actual translated Messages/Chat/Gemini hosted-search fixtures with at least two upstream turns, followed by echoing each protocol's real output into a new request. This is the evidence needed before claiming public cross-request compatibility. It is not a request to add a durable replay feature.

## Decisions and evidence limits

The ownership default can be selected now: full active outer shim invocation, all lazy tool turns, no shared default replay, explicit borrowed injection retained, no storage allocation for inactive/default replay-only preparation, and protected registry byte-identical. A normal public cross-request requirement has not been demonstrated; no cross-account exploit or production memory incident was reproduced.

The remaining release decisions are quantitative budget values and whether to qualify a wider preflight search-work bound in this slice. Source establishes missing bounds but cannot establish safe throughput/memory policy. If later fixtures demonstrate a supported public path requiring historical private values, supply an explicit source-owned resolver/seed instead of reviving singleton visibility. If callers intentionally depend on arbitrary unknown extra payload fields, characterize that direct-injection contract before narrowing those fields; the current production payload does not need them.
