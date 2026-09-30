# CFW source optimization priorities

Date: 2026-09-30. Scope: source and architecture analysis of the repair worktree at `136907308c4985a23bf9f9a952f04e815dd44e8d`, including the preserved collaboration overlay. No product changes, new tests, builds or load experiments were made for this analysis. The user's current direction is to identify useful optimizations before spending more effort on measurement infrastructure.

## Architecture decision

Keep the canonical request/turn pipeline, authenticated affinity ownership, isolated provider attempts and staged dump persistence. These boundaries provide useful correctness guarantees. The immediate problem is that their implementation sometimes carries preparation state through execution, retains several representations of the same content, or reads output faster than the client consumes it. Refine those boundaries before considering additional services or caches.

Use three rules for the next changes:

1. Separate preparation data from shared execution state, and transfer ownership when a stage finishes reading it.
2. Let downstream demand control streaming reads, with explicit byte budgets for any queue. Background capture must respect the same bound.
3. Validate and normalize internal data once at a trusted ownership boundary. Preserve full validation for external or borrowed data and preserve independent mutable request graphs for retries.

These are source-supported opportunities, not quantified speed or memory improvements. Fewer owners can shorten object lifetime without immediately reducing retained bytes; immutable strings already share storage in several current copies. The latest ordinary pilot still fails resource thresholds, as recorded in the [evidence overview](./README.md#final-c-ordinary-pilot-and-current-direction).

## Priority and applicability

| Priority | Change | Main expected benefit | Workload where it matters | Main constraint |
| --- | --- | --- | --- | --- |
| High | Separate affinity input analysis from execution state; stop carrying unused HTTP history | Shorter input lifetime; fewer container copies | Ordinary Responses, especially large inputs and long turns | Shared `actual` and compaction updates must remain live |
| High | Make HTTP SSE emitters demand-driven | Bound queued output for slow clients | Responses, Chat and Messages long streams | Preserve terminal-tail, cancellation and prompt HTTP completion |
| High | Give canonical dump paths an explicit completion contract | Remove redundant response collection and eager tee consumption | Chat, Messages and Gemini with canonical dumps | Preserve transport failure recording and noncanonical fallback |
| High | Consume compression inputs and upload buffers by stage | Reduce temporary copies and time holding large buffers | Ordinary capture-enabled requests and large dumps | Only owned immutable bytes may bypass input snapshots |
| High for ordinary CPU | Normalize internal upstream envelopes once | Fewer tree walks, arrays and objects | Requests with upstream capture enabled | Internal provenance must certify the complete safety projection |
| Medium | Reduce per-frame Promise/listener and byte-count allocations | Less allocation and CPU per frame | Many-frame streams | Preserve abort and tail-deadline semantics |
| Medium | Index output IDs during reconciliation | Replace repeated scans with linear matching | Many output/tool items | Preserve terminal authority and missing-ID matching |
| Small, fold into related work | Exact header budgets, module-level helpers and owned-header reuse | Remove small hot-path allocations | Capture-enabled requests | Keep current allowlists and ownership contracts |

## 1. Separate affinity preparation and execution lifetimes

`gateway/src/shared/affinity/analysis.ts:199` creates the canonical input snapshot. The `cloneSource` and `materialize` closures at lines 226 and 235 retain it. Ordinary authenticated requests also create this analysis through `data-plane/shared/affinity-request.ts:14–30`. The current fast path already skips owned-block/codec analysis when no owned marker is present; do not attribute that skipped work to ordinary requests.

In Responses, `responses/serve.ts:252` passes the complete affinity context into turn options. `responses/turn.ts:374,401` forwards it to the guard and `AffinityEgress`; the constructor in `shared/affinity/egress.ts:135` retains the whole context although it does not read the analysis. Deferred terminal callbacks can also retain it indirectly through complete argument objects.

Create an actual shared execution-state object containing protocol, selected/actual identity, codec/loading state and plaintext compactions. Keep input analysis with routing/materialization, and pass only execution state into the turn, guard, egress and deferred terminal work. A TypeScript `Pick` or cast does not change the retained object graph. A copied `actual` field is also wrong: server-tool execution can update it later.

The only direct analysis consumers found in application source are `selectAffinityCandidate` and `materializeAffinity`. The default Responses attempt last reads it when building `invocation.payload` at `responses/attempt.ts:375`. Later server-tool runs reuse the materialized invocation while updating execution state. The cross-protocol inner attempt at lines 406–426 uses a fixed selection and `affinityMaterialized: true`. Express this boundary explicitly; do not delete analysis inside a generic turn that may support hooks or reselection.

There is a related history lifetime issue: `responses/serve.ts:172` retains `inputItems` as `mergedInputItems` even without a durable writer, passes it into the turn and returns a new array at line 287. The production HTTP caller at `responses/http.ts:53` only consumes `response`. WebSocket continuation manages its own history using prepared source JSON. Avoid carrying or copying history through HTTP results without a consumer, while preserving the writer and internal compatibility contracts.

Expected benefit: earlier eligibility for collection and fewer containers. Removing one owner does not necessarily remove a complete body-sized allocation; other owners and shared strings remain relevant.

## 2. Apply downstream backpressure to HTTP SSE

`responses/respond.ts:57`, `chat-completions/respond.ts:231` and `messages/respond.ts:240` iterate and enqueue from `ReadableStream.start` without checking downstream demand. The loop can continue consuming upstream events while a slow client accumulates encoded output. Gemini already uses `pull` in `gemini/respond.ts:168`, but an eager dump tee reader can still consume ahead of the client.

Move to demand-driven pulls or a small byte-bounded queue. Read upstream only when capacity exists; deliver the first event immediately without waiting to assemble a batch. Keepalive frames must respect capacity too. This is a memory bound, not a proposal to maximize per-request throughput by buffering more data.

Preserve error frames, cancellation, upstream cleanup and terminal-tail rules. In particular, do not wait for background dump persistence inside the terminal HTTP pull: the existing separation between prompt HTTP close and `turn.completion` ownership must survive.

This is a source-visible long-stream/slow-client risk. It has not been shown to explain the complete CPU regression of the ordinary small fixture.

## 3. Avoid collecting response bytes that canonical dumps discard

Chat, Messages and Gemini still reach `dump.finalize(response)` through `packages/chat-flow-kit/src/serve-template.ts:272`. `gateway/src/shared/dump/accumulator.ts:314` tees the response; `drainResponse` at lines 120–140 stores all chunks and allocates a merged byte array. When canonical events exist, `buildTerminalRecord` at line 377 persists those events instead, making the collected response bytes unnecessary. The eager drain also undermines downstream backpressure.

Add an explicit canonical completion contract for these protocols. The serializer should account for actual transmitted bytes and transport errors, while canonical frames are handed off once. Preserve byte capture for passthrough and error responses without canonical frames. Do not infer the capture mode from an empty event array at stream start: events may arrive later.

Responses ordinary success already uses `finalizeTurn`; this item is not another optimization of that same path. It has substantial architectural value for the other protocols, with completion/cancellation semantics requiring careful implementation.

## 4. Shorten compression and upload ownership

`repo/dump-store.ts:88–90` feeds gzip through `Blob([part]).stream()`. An explicitly owned immutable `Uint8Array` can instead be enqueued directly into a stream feeding `CompressionStream`, avoiding the Blob input snapshot. Borrowed mutable bytes still need a snapshot; changing them during an asynchronous compression must not change stored content. Leave string handling alone unless a separate source-based reason justifies changing it.

`prepareDumpWrite` at lines 135–165 keeps the raw record while compressing the upstream envelope, then reads request and response fields later. The previous handoff repair releases these references after preparation; a private consumable packet can release each envelope/event field immediately after its last preparation read. Avoid eagerly stringifying every body or compressing all three concurrently, which would increase simultaneous live representations.

`putPreparedDumpBodies` at lines 192–202 clears all compressed body slots only after every started upload settles. Let each upload take its own bytes and clear its packet slot before awaiting storage. Its buffer can then become collectible when that upload finishes, without waiting for a slower sidecar.

Keep settlement of all started writes, staging/tombstones, optional-sidecar fallback, row fencing and publication order. Earlier release primarily reduces the duration of memory occupancy; it does not establish a large CPU saving.

## 5. Normalize trusted upstream envelopes once

`shared/dump/upstream-attempts.ts:368–418` creates and deeply freezes an internal snapshot. `safeUpstreamExchangesForPersistence` at lines 460–563 then validates and rebuilds its headers, bodies and attempts immediately before `dump-store.ts:153–154` serializes it.

Unify internal construction with the complete persistence-safe projection, or register the resulting fully validated frozen envelope in a private `WeakSet` and reuse it by identity. Unknown input and external lookalikes must still pass the full projection. The existing `internallyEncodedBodies` set only certifies a narrower base64 condition; it is not proof that the whole envelope is safe.

Preserve header allowlists, body/aggregate budgets, truncation metadata, counts and borrowed `finish()` identity. This removes repeated traversal and container allocation, not an entire second copy of every base64 string: the current trees already share those immutable values. Among the identified items, this directly targets capture-enabled ordinary-request CPU rather than only large or slow-stream cases.

## 6. Reduce repeated stream machinery

`data-plane/chat-flow/shared/stream-tail.ts:25–40` creates an interruption Promise, a race and an abort listener for each `next()`. Upstream and canonical consumers each apply this machinery for distinct semantic reasons. Preserve both protections, but use one listener per consumer with explicit pending-pull state; arm the absolute tail deadline only after the terminal condition.

Do not repeatedly race against one never-settling shared abort Promise: its reactions would accumulate. Preserve cancellation and cleanup for the currently pending read.

Length-only checks in `stream-tail.ts:21`, `shared/affinity/egress.ts:57` and the WebSocket UTF-8 helper can count exact UTF-8 bytes without allocating a complete encoded buffer when the text already exists. Preserve surrogate/Unicode behavior. Tail observation already serializes for its budget only after terminal; do not describe it as a full serialization of every ordinary frame.

These changes mainly help high frame counts. A few frames in an ordinary request do not support attributing the entire CPU gap to this machinery.

## 7. Index output-item identity

`packages/protocols-llm/src/responses/final-output.ts:13` scans existing items for each done item. Its terminal reconciliation at line 32 repeatedly expands and scans the Map. `gateway/src/shared/affinity/egress.ts:225` has a related duplicate-ID scan. Many tool/output items can therefore cause quadratic matching and repeated temporary arrays.

Maintain an ID-to-index map, reconcile in linear passes and sort only at the final boundary where ordering requires it. Preserve terminal authority, ID-first matching, positional fallback for missing IDs, deduplication and extra items. Ordinary single-item responses gain little from this change. Coordinate future edits in the protocol package with the preserved collaboration overlay; this analysis does not modify it.

## 8. Fold small allocation fixes into their owning changes

- `upstream-attempts.ts:86–93` constructs a tuple, serializes it and UTF-8 encodes it to count a header budget. With the current ASCII content-type allowlist and normalized decimal content-length, the exact tuple cost is `name.length + value.length + 8`. Couple this calculation to those invariants if the allowlist changes.
- Move stateless validation helpers and `freezePairs` out of request-local functions to avoid repeated closure creation and bundle keep-name work.
- `accumulator.ts:262` already owns header tuples; later copies at lines 416/421 can use the same immutable internal representation. Keep the first external-to-owned copy.
- In `affinity/analysis.ts:64`, filter actual string opaque slots before canonicalizing companion data where the input contract permits it. This affects requests entering owned-block analysis, not the already-skipped ordinary no-marker path. Egress must still account for recognized reasoning companions before a signature arrives.

These are useful cleanup within the relevant modules, not the main architectural remedy.

## Implementation sequence after this analysis

The following is planned work, not completed optimization:

- [ ] Separate affinity preparation from shared execution state, including deferred closure captures and unused HTTP history.
- [ ] Consume owned compression/upload inputs by stage; normalize the internal upstream envelope once and include its small allocation fixes. This provides a parallel focus on ordinary capture-enabled CPU and memory lifetime.
- [ ] Introduce demand-driven serializers together with the canonical dump completion boundary so an eager tee cannot bypass their backpressure.
- [ ] Simplify per-frame interruption and byte counting, then index output-item reconciliation where it is independent of the preserved overlay.

Do not add more caches, compression parallelism, background queues or services merely to move work elsewhere. They can increase retained data and introduce authority, completion or rollback complexity. Defer lazy provider construction: it changes error timing/authority boundaries for a small speculative benefit.

No new diagnostic campaign is the immediate next step. Implement bounded changes from the source findings, then use focused semantic checks and the existing qualification gates for the resulting candidate. Resource acceptance, catalog/affinity rollback compatibility and vNext integration remain open. Production has not changed; the completed isolated pilot was restored to its archived ordinary version.
