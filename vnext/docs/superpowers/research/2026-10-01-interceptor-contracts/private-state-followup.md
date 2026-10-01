# Private payload ownership follow-up

Date: 2026-10-01. Read-only follow-up for planning; no implementation, tests, probes, benchmarks, or deployment. The active batch remains the 21 request-normalizer migration.

`F` = `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`, observed HEAD `840fdf2821ea0cb3a96f68e123caacfe8e9c48bf` when this follow-up began, plus the preserved collaboration overlay. The earlier audit began at `c3a365511211f709a19207851317587f250740a7`; development advanced while this separate read-only task ran. Private-state source pointers below describe the files inspected here. `R` = `/Volumes/Projects/copilot-gateway`, previously verified clean at `1d7dcd923e260e425120cca0c7a240e93720af27`.

## Finding to use for prioritization

The default store is a process/isolate-local, item-ID-keyed TTL Map, not a request-owned scratchpad. The verified production dependency is replay across the hosted-tool loop's upstream turns inside one logical response. A normal public cross-request dependency on this Map is **not established** by the inspected paths, and the current native Responses web-search gate argues against describing it as native Responses continuation storage.

The same singleton can mechanically return a prior invocation's entry when given the same unexpired ID, but that is a lower-level capability, not evidence that an ordinary HTTP/WS conversation reaches it. Do not build a durable replay feature merely to preserve an assumed requirement. Conversely, do not replace the singleton at an arbitrary request/fetch boundary: it must survive the entire lazy multi-turn result, and the existing replay-input hook and fallback behavior need characterization before removing cross-invocation visibility.

## Exact write/read path

| Step | Verified behavior | Source in F |
|---|---|---|
| Construction | One module-level `defaultPrivatePayloadStore` is captured when the Responses interceptor registry is constructed | `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload-store.ts:36-68`; `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/index.ts:9,76` |
| Store injection | The shim passes the captured store to every plugin's per-invocation request context, alongside a separately supplied API key | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts:1099-1110` |
| Key creation | Search slots receive a new `ws_` item ID; generated IDs use 16 cryptographically random bytes. The store key is that item ID, not the upstream function `call_id` | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts:358,505-530`; `vnext/packages/protocols-llm/src/responses/item-id.ts:19-26` |
| Payload creation | Search terminal creates `{ v: 1, functionCallItem, ir }`. `functionCallItem` preserves the repaired per-slot arguments and original call ID, with an index suffix for fanout | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts:338-341,604-655` |
| Write | After the slot lifecycle completes, the common materializer stores `step.value.privatePayload` under `slot.id`, then emits the terminal item/events | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts:932-950` |
| First input rewrite | Active plugins transform incoming history before the first downstream invocation | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts:1170-1172` |
| Later tool turn | The loop combines its original input with accumulated output, transforms those hosted-tool items, assigns the next payload, then invokes the inner chain again | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts:1023-1050` |
| Read | Search's transform looks up `wireItem.id`; the callback directly calls `requestCtx.store.getPrivatePayload(id)` | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts:411-435,592-596` |
| Hit | A version/shape-valid hit restores the saved function call and renders its private IR into the paired function output | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts:344-355,424-435` |
| Miss | A missing/expired/unknown-version entry synthesizes a new paired call and a notice that prior search results were not preserved. It deliberately does not trust wire `item.results` | `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts:386-410,438-479` |

Production search found one `registerPrivatePayload` call site, in the common materializer, and one plugin `getPrivatePayload` call site, in web search. The image plugin is not a second private-data reader.

## Cross-turn versus cross-request requirements

### Confirmed: same logical response, multiple upstream turns

The search result sent to the next upstream turn is reconstructed from the saved IR. This is necessary even when the client did not request `web_search_call.results`; the public item may contain only its action while the private payload retains the full search result (`web-search.ts:638-655`). Allocating a new store for each upstream `run()`, each emitted frame, or each translated target reentry would replace a real search result with the fallback notice in that response.

The store is used after `withResponsesServerToolShim` returns its `EventResult`: further searches and replays happen while `runMultiTurnLoop` is being pulled (`server-tool-shim.ts:1195-1229`). A `finally` around only the initial interceptor promise would run too early. Cleanup belongs to the full result-stream/turn owner, including drain, cancellation, and abandonment paths, not merely completion of the function that returns the iterable.

### Not established: ordinary cross-request replay through this Map

The current registration explicitly returns inactive for `sourceApi === 'responses'`, including the default when it is missing. For another inbound protocol it additionally requires the Responses web-search shim flag, hosted tool or replay item, and enabled search configuration (`web-search.ts:535-575`). Native Responses previous-response hydration therefore does not imply native search-private-payload hydration.

The three inbound translation builders inspected here create normal Responses message/reasoning/function-call/function-output input items, not `web_search_call` input items:

- Messages: `F/vnext/packages/translate/src/messages-via-responses/request.ts:47-51,118-197`.
- Chat Completions: `F/vnext/packages/translate/src/chat-completions-via-responses/request.ts:35-42,75-127`.
- Gemini: `F/vnext/packages/translate/src/gemini-via-responses/request.ts:44-72,135-205`.

The Responses attempt derives `sourceApi` from inherited source telemetry, rather than taking it from a caller-controlled payload property (`F/vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts:350-355`). A normal source protocol round trip carrying only its own public history has not been shown to reintroduce the same `ws_` key into this lookup. Existing activation test source explicitly expects native replay to remain inactive (`F/vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools/web-search-activation.test.ts:68-95`); those tests were read, not run.

There is still a conditional cross-invocation path at the shim API: if a later activated invocation already contains a `web_search_call` with the same ID and shares the default store, the first-input rewrite can hit it even without declaring the hosted tool again (`web-search.ts:554-558,592-597`; `server-tool-shim.ts:1170-1177`). This is why removing all cross-invocation visibility should be a deliberate, tested ownership change. It is not grounds to claim that current production cross-request continuation requires it.

### Persistence wiring does not supply a fallback backing

`responses_items` has `private_json`, API-key-aware lookup, and expiry methods in the repository contract/implementation (`F/vnext/packages/gateway/src/repo/types.ts:537-569`; `repo/shared/repos.ts:1342-1393`). A repository-wide search found only those declarations/implementations and Bun/Cloudflare adapter forwarding, with no production call wiring from this private store to `responsesItems.insertMany` or `lookupMany`. The common materializer's comment that output persistence captures the private value does not match this F call graph.

F's real native Responses continuation uses a different `ResponsesSnapshotStore`: snapshots contain owner, model, items, and timestamps, not a private-payload map (`F/vnext/packages/responses-store/src/types.ts:16-38`). The completion writer saves input/output items (`F/vnext/packages/gateway/src/data-plane/chat-flow/responses/completion-snapshot.ts:7-24`), and native preparation expands those snapshots under the API key (`responses/serve.ts:149-182`). WebSocket local continuation stores only create configuration and public items (`responses/local-continuation.ts:4-34`). None of these paths seeds `defaultPrivatePayloadStore`.

R has the missing source-owned replay bridge, rather than relying on a global TTL map: output capture attaches the store's private payload to an item row with API-key ownership (`R/packages/gateway/src/data-plane/chat/openai-responses/items/output.ts:61-81`); hydration reads it into an explicit private-payload seed (`items/hydrate.ts:11-45`); lookup is owner-scoped (`items/store.ts:173-179,274-281`); and `beginAttempt` reseeds the scratchpad (`items/store.ts:160-170`). R's native search activation also differs (`R/packages/gateway/src/data-plane/chat/openai-responses/interceptors/server-tools/web-search.ts:704-705`). A local Map replacement would not reproduce R's cross-request contract.

## Payload size and retained data

**Search is the real data-bearing case.** The stored value retains the function call's arguments string and search/open/find IR: action, result array, URLs, titles, snippets, and optional model-facing output text (`F/vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/web-search.ts:313-355,604-655`; `F/vnext/packages/gateway/src/data-plane/tools/web-search/operations.ts:280-331`). Client `include` affects the public result only; it does not reduce the private value.

Several local bounds exist, but they are not a store byte budget:

- Search context asks providers for 10/20/40 results per query; mapped search snippets are capped at 2,048 characters (`operations.ts:28-51,489-524`). The common mapper does not truncate the result count or cap title/URL lengths itself.
- Open-page provider adapters use a 10,240-byte content cap; the IR stores that page text plus a truncation suffix. Find returns at most 10 matches with 200-character context (`F/vnext/packages/gateway/src/data-plane/tools/web-search/types.ts:14`; `operations.ts:694-704,742-752`). These do not cap total pages or map entries.
- Clean batched searches are grouped into one IR, and results from all queries are concatenated (`plan-operations.ts:131-155`; `operations.ts:548-562`). One stored payload can therefore grow with query count. Open/find and unsupported operations can fan out into many stored slots.
- `parseWebSearchOperations` walks the complete provided arrays; `sliceArguments` preserves the selected raw argument entries, including unsupported fields and malformed values (`operations.ts:180-257`; `plan-operations.ts:69-89`). The copied arguments string is not bounded by snippet/page caps.
- The web-search iteration cap is 30, but it controls real search work by loop iteration, not bytes or slots within a batch; beyond the cap the plugin creates refusal slots (`web-search.ts:495-530`). Optional `max_tool_calls` is tracked per dispatched function, not per fanned-out slot (`server-tool-shim.ts:681-686,1181-1184`). Neither proves a bound on retained Map size.
- `return_token_budget` is carried in the canonical hosted tool but not enforced by this local shim (`web-search.ts:180-187,240-245`). It must not be described as a private-payload limit.

**Images are not stored here.** `imageTerminal` returns the base64 result in the public `image_generation_call` and omits `privatePayload` (`F/vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/image-generation.ts:1361-1383`). Partial images are yielded as events (`:1510-1525`). Image replay reads the public item's `result` and reconstructs an input image, without the store (`:1537-1593,1622-1629`). The common materializer still registers `undefined` for image terminals, so the global Map retains an ID/expiry entry but not the image bytes. The store's header comment suggesting image partial blobs are an example is not evidence that current image bytes enter this Map.

There is also a separate request-scoped web page cache in the search registration (`web-search.ts:582-589`; `operations.ts:618-624`). Its memory lifetime and the surrounding accumulated output can overlap with the private IR. Shrinking the private store alone would not prove a whole-request peak-memory improvement.

## Isolation, cleanup, and limits actually enforced

| Property | Current verified mechanism | Limit of that evidence |
|---|---|---|
| Key identity | Random `ws_`/`ig_` IDs, 16 random bytes | Low accidental collision likelihood does not authenticate an owner |
| Owner isolation in this Map | None: `register(id, value)` / `get(id)` have no API-key, user, request, or conversation dimension | API-key search enablement is checked separately; it is not an ownership check on a looked-up item |
| Read validation | Search private version and minimum shape validation | A shape-valid entry for the wrong owner would still pass if a caller can reach the lookup with its ID; no public cross-account exploit was reproduced or established |
| TTL | Absolute five-minute expiry from each write; reads do not refresh it | A long-running active loop can lose earlier entries after five minutes; later hits then fall back |
| Expiry cleanup | Every write scans all entries; reading an expired ID deletes that ID | No timer; idle expired bytes remain until a later write/read or process/isolate release |
| Completion cleanup | No clear/delete/dispose API; the loop's `finally` resolves metadata only | Finished/failed/cancelled responses do not actively release these map references |
| Capacity | No count, per-entry byte, total byte, or per-owner admission bound | Per-operation result limits do not bound aggregate live entries under concurrency |
| Copy isolation | Stored and returned values are the original references | No clone/freeze protects replay data against later mutation by code holding those references |
| Durability | Module instance memory only | Process restart, isolate replacement, or routing to another isolate loses it; this is not durable replay |

Sources: `F/vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload-store.ts:21-68`; `server-tools/web-search.ts:344-355,425-432,547-596`; `server-tool-shim.ts:1084-1095`. The comments claiming cross-account misses and `store:false` misses describe an intended persisted-store model; the actual Map does not check either property.

Each registration scans the current Map. With many still-live entries, repeated writes can accumulate quadratic total scan work as the Map grows. That is an algorithmic property of the source, not a measured CFW CPU incident. No entry counts, retained-byte measurements, heap profiles, traffic rates, or exploitability measurements were collected here.

## Smallest useful follow-up boundary

Prefer a **full logical response scratchpad** owned by the existing hosted-tool invocation/result lifetime, with explicit optional replay seeding. Keep the tool dispatch loop, item IDs, public output, producer-domain adapters, and native Responses snapshot owner unchanged. A Map allocated once inside the outer shim invocation can survive every inner `run()` through the returned iterator closure; a Map allocated inside `runMultiTurnLoop` per turn or freed when the initial interceptor promise resolves cannot.

Before selecting that implementation, characterize the existing public paths with focused fixtures: translated Messages/Chat/Gemini search through at least two tool turns; a later request echoing the source protocol's actual output; direct activated replay input with a shared store; native Responses replay remains inactive; cancellation before/after materialization; long-running TTL expiry; and simultaneous API keys. These are future checks, not checks performed by this report.

Then choose the narrow result supported by that evidence:

1. If public cross-request lookup remains unreachable, make scratchpad ownership explicit for the full shim invocation and retain today's miss notice for unsupported historical private replay. Skip `undefined` registrations. Do not add D1 writes or new private continuation fields merely to reproduce R.
2. If a supported cross-request path is demonstrated, preserve it through an explicit owner-scoped replay resolver/seed supplied by the existing source owner. A bounded owner-scoped warm cache can be a compatibility bridge only if current warm-cache replay is the chosen contract; it must not masquerade as durable storage. Anonymous requests need separate scoping rather than a shared empty API-key namespace.
3. Define limits separately from storage lifetime: per-entry/aggregate admission bounds and a deliberate overflow outcome. Do not silently evict values still required by the active tool loop and replace real search results with the history-missing notice. Bound or reject work before it grows beyond the budget, and avoid serializing/cloning the whole payload repeatedly on every read.

The reason not to simply change the singleton to “request-local” is therefore concrete lifecycle ambiguity and a still-existing conditional replay-input behavior, **not verified evidence that standard native Responses cross-request continuation currently depends on the singleton**. The correct smallest scope is the complete lazy hosted-tool response with its established continuation policy, not one network request or provider fetch.

## Priority and unverified risks

- **Next bounded ownership increment:** clarify scratchpad lifetime, isolate owner identity where replay exists, stop meaningless undefined entries, and remove stale persistence/lifetime claims. This can remain independent of the 21 normalizers.
- **Resource qualification before release claims:** measure representative batched search/open history, concurrent responses, abandoned streams, and idle retention; check both active-loop and post-completion bytes and write-sweep CPU. This audit establishes missing aggregate bounds, not actual production exhaustion.
- **Separate feature decision:** durable private search replay or richer cross-protocol history preservation. The current unused repo surface is not an authorization or requirement to enable it.
- **Do not report as confirmed incidents:** a cross-account leak, a production memory leak, an actual five-minute active-loop failure, or a required public cross-request replay regression. The source shows preconditions and gaps; this read-only task did not execute the scenarios.
