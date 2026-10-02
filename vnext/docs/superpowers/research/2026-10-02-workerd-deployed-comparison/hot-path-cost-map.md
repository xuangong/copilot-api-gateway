# Responses JSON/SSE hot-path resource work map

This is a read-only source audit for the ordinary `/v1/responses` fixture: a 64 KiB payload, three eligible stored custom upstreams, dump writer enabled, and Responses retention disabled. It describes work to locate in the local workerd profiles, not measured CPU savings or a performance prediction.

The subsequent Formal 02 measurements and bundle-checked profile interpretation are recorded in [results](results.md). The anchors below retain their original source-audit meaning; measured sample weights and mapping limits belong to that later report.

## Source identities and scope

- **A**: `/Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/baseline`, verified HEAD `e660fb4dfcf1734d10f89e52e2d739b2985c634b`.
- **B**: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`, verified HEAD `e90b8ee5a5feb6e99ef45cad8ca4463c245c25e7`, plus the existing collaboration overlay. References describe the live source, including that overlay.
- Unless stated otherwise, paths below are relative to each variant's `vnext/packages/gateway/src/`.
- The ordinary fixture has no owned affinity carrier, opaque reasoning output, `previous_response_id`, compact action, server tool, or retry. Those features can take additional branches and are not represented by the ordinary-path counts.
- A **warm hit** means configuration, catalog, and (for B) routing projection are already retained and valid in the same isolate. A cold start or due refresh must be labelled separately.

## Six concrete work differences

### 1. Warm routing replaces all-provider construction/full catalog projection with descriptors and selected materialization

**A work.** `data-plane/providers/registry.ts:310-353` (`listProviderBindings`) constructs a provider for each enabled eligible upstream, gets its cached catalog, calls `setModelCatalog`, computes flags/disabled sets, and maps every enabled catalog model through `modelToBindingModel`. `data-plane/routing/candidates.ts:69-86` then filters the full binding array. The warm catalog hit still builds the three custom providers and their full model bindings; `registry.ts:233-240` (`getCachedModels`) also computes the configuration-based cache key on each read.

**B work removed/replaced.** `data-plane/providers/registry.ts:341-380` (`listRoutingBindings`) reads retained catalogs and reuses `RoutingProjectionCache.get`. With three cache hits, the provider closures remain deferred until the winning descriptor is materialized. `registry.ts:401-422` (`collect`, `materialize`) looks up requested IDs, builds descriptors, and clones only the selected model/flags into an execution binding. Ordinary no-owned-state selection returns the first successful materialization (`data-plane/shared/affinity-request.ts:41-54`, `selectAffinityCandidate`), so it constructs one provider on this successful fixture path.

**B work added/retained.** All three upstreams are still visited; flags, disabled sets, request-local groups and closures still exist. Candidate getters can repeat the small descriptor/filter pass (`data-plane/routing/candidates.ts:95-107`). `RoutingProjection.find` uses an ID index but allocates/sorts a result (`data-plane/providers/routing-projection.ts:56-59`). Both variants retain configuration row clones, owner merge/sort, and all-visible proxy preflight (`A registry.ts:297-331`; `B registry.ts:268-310`; `A repo/configuration-cache.ts:54,248-251`; `B repo/configuration-cache.ts:54,245-248`). B additionally constructs an authoritative fetcher for the selected provider (`B registry.ts:212-215,359-368`). This is not elimination of routing or proxy work.

**Profile anchors.** A: `listProviderBindings`, `createProviderFromUpstream`, `getCachedModels`, `modelsCacheKey`, `modelToBindingModel`, `genericModelEndpoints`, `filterBindingCandidates`. B: `listRoutingBindings`, `CatalogCoordinator.read`, `RoutingProjectionCache.get`, `RoutingProjection.find`, `collect`, `materialize`, `selectAffinityCandidate`, `authoritativeFetchers`, `createProviderFromUpstream`.

**Window.** Both JSON/SSE pay routing before dispatch. B projection construction/freezing (`routing-projection.ts:21-54`) and `CatalogCoordinator.run` database read/lease/discovery (`catalog-coordinator.ts:152-211`) belong to cold/miss/refresh paths, not every warm request. The ordinary retained fast path is `catalog-coordinator.ts:111-116,143-150`; due freshness can launch background refresh even while returning retained data.

### 2. Affinity input ownership adds container traversal/copies, without ordinary-path cryptography or preparing all candidates

**A work.** A Responses preprocessing expands prior history and routes the model (`data-plane/chat-flow/responses/serve.ts:129-154`); it has no `createRequestAffinity` invocation. Do not treat the absence of affinity as absence of parsing, request translation, or upstream request serialization.

**B added work.** `responses/serve.ts:190-195` invokes `createRequestAffinity`. For an owner/key-authenticated ordinary request, `data-plane/shared/affinity-request.ts:14-31` scans for a marker and creates an analysis snapshot. `shared/affinity/analysis.ts:202-204` calls `cloneAffinityInput`, which traverses mutable JSON containers and defines copied properties while sharing immutable strings (`shared/affinity/input-copy.ts:13-41`). Dispatch calls `materializeAffinity` (`responses/attempt.ts:357`; `data-plane/shared/affinity-request.ts:103-105`), and analysis materialization copies the containers again (`analysis.ts:239-241`). A large text string does not itself imply a second string encoding by this copy routine.

**Ordinary-path limits.** Missing owner/key skips analysis; fixture auth determines whether this item is exercised. An ordinary request does not eagerly load an affinity secret or codec (`affinity-request.ts:20-31`) and does not run the owned-state all-candidate preparation loop (`:48-54` versus `:58-100`). Plain text output does not require opaque carrier encoding; `AffinityEgress.item` returns unsigned items before codec loading (`shared/affinity/egress.ts:138-149`). B still adds frame guards/egress calls (`responses/turn.ts:427-434,446-470`).

**Profile anchors.** B: `createRequestAffinity`, `containsAffinityMarker`, `analyzeAffinityRequest`, `cloneAffinityInput`, `materializeAffinity`, `guardAffinityFrames`, `AffinityEgress.responseEvent`. Crypto functions or `prepareAffinityExecution` in this ordinary profile would need an explanation from the actual fixture/auth/output, rather than being attributed to every request.

**Window.** Input scan/copies are before dispatch in both JSON/SSE; guards/egress are during frame consumption. They are added ownership/semantic work, not removed transport duplication.

### 3. Canonical dump finalization removes the second HTTP response branch, while bounded frame projection adds work

**A duplicate transport work.** `shared/dump/accumulator.ts:199-227` (`finalize`) tees the already rendered HTTP body, independently reads the capture branch, retains chunks, allocates a complete `Uint8Array`, and copies all chunks into it. `:256-265` then prefers the canonical event log over those wire bytes. On a normal frame-producing Responses request, the complete HTTP capture therefore happens even though the stored response is the frame log. A's `frame` hook simply retains the frame reference (`:135-137`).

**B removed work.** The canonical Responses turn uses `finalizeTurn` (`responses/turn.ts:385-389`; `shared/dump/accumulator.ts:334-351`). When frames exist it writes directly from the canonical log, without a Response tee, independent wire drain, or wire chunk merge. This applies to the ordinary JSON/SSE path, not all B routes: legacy `finalize` retains a tee at `accumulator.ts:387-409`.

**B added work.** Each canonical frame is projected into a budget-owned JSON graph (`accumulator.ts:272-278`; `shared/dump/capture-budget.ts:15-69,134-154`). The projector recursively inspects property descriptors, counts retained data, and copies objects/arrays while sharing strings; it neither stringifies nor reparses each frame. Request reservations and scope/retirement accounting are also new (`accumulator.ts:182-193`; `capture-budget.ts:121-131,179-194`). Limits are 4 MiB per capture, 16 MiB per environment, and 8,192 frames (`capture-budget.ts:4-8`); these are accounting limits, not measured total heap/codec memory. Any omission under concurrency must be checked as an output change, not silently counted as a CPU win.

**Profile anchors.** A: `DumpAccumulatorImpl.finalize` and its capture-reader closure, `Uint8Array` allocation/`set`, `write`. B: `finalizeTurn`, `frame`, `CaptureFacade.frame`, `CaptureFacade.project`, `projectGraph`/`visit`, `CaptureFacade.bytes`, `finishRetirement`.

**Window.** A wire capture/merge extends through response completion and background settlement. B frame projection occurs during consumption; canonical write and retirement extend past delivery. Both JSON/SSE still serialize and compress the canonical event log for storage.

### 4. Upstream exchange diagnostics add bounded byte capture, terminal base64, gzip, and a third owned object

**A work.** There is no upstream-exchanges dump sidecar. With nonempty ordinary request/response captures, `repo/dump-store.ts:141-203` stages and writes two owned objects plus the dump row.

**B added live work.** The selected provider gets an observation context (`data-plane/providers/registry.ts:311-313,359-365`). `shared/dump/upstream-dial-adapter.ts:33-79` observes prepared request text and wraps the returned upstream body. `shared/dump/upstream-attempts.ts:286-305` counts prepared request bytes and captures a prefix; `shared/dump/bounded-utf8.ts:35-47` counts the whole string while encoding only the bounded prefix. `upstream-attempts.ts:308-358` wraps downstream demand with HWM 0, counts bytes, and copies bounded response prefixes. It does not tee or run an independent drain. Limits are 64 KiB request prefix, 256 KiB response prefix, and 1 MiB total body capture (`upstream-attempts.ts:7-14`), so a 64 KiB logical fixture payload can still exceed the request prefix after its JSON envelope is added.

**B added terminal/storage work.** `finish`/`takeSnapshot` freezes metadata and converts prefixes to base64 (`upstream-attempts.ts:373-438`). `BytePrefix.base64` concatenates multipage captures before encoding (`:147-153`). `repo/dump-store.ts:186-220` serializes and gzips the sidecar before consuming the core response preparation. Normal successful persistence stages three objects and records `upstream_exchanges_descriptor` (`:308-338`). This is an extra object in the existing stage statement and an extra descriptor in the existing dump-row insert, not an unconditional extra SQL statement; sidecar failure can take repair/fallback SQL branches (`:288-305,329-347`).

**Profile anchors.** B: `createUpstreamDialObservationContext`, `observePreparedText`, `boundedUtf8`, `utf8ByteLength`, `observeResponse`/its pull closure, `capture`, `BytePrefix.append`, `BytePrefix.base64`, `finish`, `takeSnapshot`, `consumeUpstreamBody`, `gzip`, `persistPreparedDump`, `putPreparedDumpBodies`.

**Window.** Prepared-request capture is at dial; response capture follows the actual consumer for JSON/SSE. Base64/JSON/gzip/R2/D1 are settlement work. Ordinary success should reach upstream EOF; cancellation/early parser return is a separate outcome and must use the terminal rules in `sidecar-terminal-audit.md`.

### 5. SSE moves from eager whole-frame encoding to demand-driven bounded encoding; JSON retains one wire serialization

**A SSE work.** `responses/respond.ts:197-264` (`renderEventsAsSSE`) starts an eager `for await` loop in `ReadableStream.start`; each frame is mapped to an SSE frame and fully encoded before enqueue (`:223-229`). There is no desired-size gating on that loop. The dump tee in item 3 adds another consumer of this encoded stream.

**B SSE change.** `responses/respond.ts:55-68` delegates to `demandSse`. `shared/demand-sse.ts:60-114` pulls on demand, keeps one serialized pending frame, and emits encoded chunks under a 16 KiB byte queue (`:5,122`). Large frames add slice/offset/`encodeInto` iterations; ordinary small frames use exact `TextEncoder.encode` allocations (`:89-107`). This changes allocation/queue shape and backpressure; it is not proof of less total UTF-8 encoding. Both still stringify each emitted event and run keepalive logic.

**JSON retained/changed work.** A builds its final result via reassembly/optional body translation and `Response.json` (`responses/respond.ts:279-309`). B renders the canonical terminal, calls `JSON.stringify` once, counts with `Buffer.byteLength`, and reuses that same string for the Response (`responses/respond.ts:24-49`). The reuse avoids adding a second serialization for B's byte accounting. A also has one wire JSON serialization here; do not claim B removed an A second stringify on this code evidence. Cross-protocol B still collects the producer result and calls the body translator (`responses/source-result.ts:20-29`); native JSON upstream parsing/event synthesis remains (see retained work below).

**Profile anchors.** A: `renderEventsAsSSE`, `responsesProtocolFrameToSSEFrame`, `encodeSseFrame`, `renderEventsAsJson`, protocol reassemblers. B: `renderResponsesTurn`, `encode`, `demandSse`/pull closure, `TextEncoder.encode`/`encodeInto`, `Buffer.byteLength`, `recordSentPayloadBytes`, `prepareResponsesSource`, `jsonFrames`, `collectProducerResult`.

**Window.** JSON serializes the terminal once before delivery; SSE encoding follows consumer demand. A fast fully draining consumer can hide backpressure differences in wall time. Heap/GC attribution requires measurement, and native encoder/compression costs may not appear as named JS samples.

### 6. Success-tail validation and explicit turn settlement add iterator/timer/receipt work, with persistence retained

**A behavior/work.** `shared/upstream-telemetry` at `data-plane/chat-flow/shared/upstream-telemetry.ts:73-100` yields a terminal and returns immediately afterward (`:93-95`). Responses then schedules `persistFromEventResult`, which records usage and performance (`responses/respond.ts:137-164,243-245,306-307`).

**B added work.** `withUpstreamTelemetry` delays successful terminal emission until the producer tail is consumed (`data-plane/chat-flow/shared/upstream-telemetry.ts:111-153`). A canonical Responses turn also observes a terminal candidate and validates its tail (`responses/turn.ts:437-485`). `StreamTail.next` creates per-read settlement callbacks, maintains an abort listener, and starts a timer after the first terminal candidate (`shared/stream-tail.ts:24-65`). Post-terminal observed frames can incur `JSON.stringify`/UTF-8 byte accounting (`:30-34`); this is conditional tail work, not serialization of every pre-terminal frame. Bounds are 1 second, 256 frames, and 1 MiB (`:4-7`).

**B settlement ownership.** `createResponsesTurn` allocates readiness/facts/receipt/completion state (`responses/turn.ts:235-278`); `finalize` performs bounded iterator cleanup, metadata settlement, sink receipts, usage/performance writes, and canonical dump finalization (`:340-399`). `closeStream` races iterator return against a cleanup timer (`shared/stream-tail.ts:89-96`). Item 4 adds sidecar storage; core usage/performance and dump persistence remain. HTTP JSON resolves delivery after canonical terminal validation and continues draining finalization (`responses/respond.ts:24-37`); SSE similarly drains terminal cleanup after closing output (`shared/demand-sse.ts:48-50,114`). HTTP completion alone is therefore not the end of the CPU/storage work window.

**Profile anchors.** A: `withUpstreamTelemetry`/`run`, `persistFromEventResult`, `recordUsage`, `recordPerformance`. B: `createResponsesTurn`, its `run`/`finalize`/`invokeSink` closures, `ResponsesFinalOutput.observe`, `withUpstreamTelemetry`, `StreamTail.next`/`observe`/`start`, `closeStream`, `settleStreamMetadata`, `prepareProjectionInput`, `resolveFacts`, `recordUsage`, `recordPerformance`.

**Window.** Both JSON/SSE pay ordinary iterator/terminal processing. Tail timers mostly disappear immediately at clean EOF; timeout bounds do not imply a fixed 1-second ordinary delay. Cold/slow/failure tails must be separated from ordinary EOF. Full settlement captures additional B work as well as the removed A wire-capture branch.

## Retained work and comparison guardrails

- **Ingress was already single-read in A.** Both use `readRequestBody` (`shared/dump/request-body.ts:30-36`) and buffered-byte `parseJsonBody` (`data-plane/chat-flow/shared/dump-open.ts:45-47`). `takeRequestBody` transfers/clears the same byte slot (`shared/dump/request-body.ts:19-22`). B does not remove an A second ingress-body read.
- **Retention disabled does not disable dumps.** A's `responses/http.ts:60-76` disables `attachStreamSidecar`/`attachNonStreamSidecar` when Responses retention is zero. B's `responses/serve.ts:182-187` leaves `onCompleted` absent, and its HTTP entry passes `retainInputHistory: false` (`responses/http.ts:53-55`). Thus no Responses snapshot tee/clone/store saving can be attributed to B in this fixture. Request/response dump gzip, object writes, dump D1 insert, usage, and performance remain enabled.
- **Upstream JSON buffering/parsing/synthesis persists.** A `responses/attempt.ts:176-180,441-455` and B `:168-172,473-495` still fully read/parse upstream JSON, observe it, and synthesize protocol frames. SSE still parses upstream frames. `fetchWithPerformance`'s occupancy body wrapper already existed in A (`data-plane/chat-flow/shared/performance-upstream.ts:9-35`) and remains in B; it is not the newly added sidecar wrapper.
- **Compression is not removed.** A request preparation is eager (`shared/dump/accumulator.ts:104-109`); B also starts admitted request preparation eagerly (`:182-193`). B's terminal compression sequence is lazy/serial (`repo/dump-store.ts:209-220`), and transferred byte compression avoids Blob's borrowed-byte snapshot for those inputs (`:94-103`), while string compression still enters through Blob. All gzip/native/R2/D1 work must be included in the settlement result.
- **Profiles are evidence to collect.** Function names above are recognizable source anchors, not functions already observed consuming CPU. Bundling can merge names or expose anonymous closures/native samples; map the profile with source locations. Report wire/status/dump equivalence and object counts before interpreting aggregate CPU, wall time, or allocation differences. Do not infer percentages from this map.

Verification for this report: source files were read with line-numbered views in the two isolated roots. No runtime, test, install, network call, generated-asset rebuild, or source/index mutation was performed for this audit. Only this report was created.

## Subsequent capture evidence

Formal 01 later demonstrated the correctness cost behind item 3: four A cross-protocol SSE captures retained mutated early output arrays, while their original wire frames were correct at emission time. The legacy reference-retention shortcut therefore cannot be restored as a safe optimization. B's owned projection removes this aliasing mechanism in source; at that stage a fresh B matrix was still required. Formal 02 subsequently observed all four matched B captures passing, with the four A failures retained. These cells are outside the ordinary native Responses latency fixture, so they neither quantify the copying cost nor explain a measured percentage. See [qualification](qualification.md) and [results](results.md) for separate reader bugs, strict outcomes, and the preserved incomplete attempt.
