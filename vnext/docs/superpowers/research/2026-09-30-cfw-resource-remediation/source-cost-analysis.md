# Ordinary Responses: sources of the remaining cost

Snapshot note: this analysis describes the pre-architecture repair candidate. The subsequent bounded implementation, verification and remaining gaps are tracked in [request-boundaries-results.md](./request-boundaries-results.md); the original source observations and measurement conclusions below retain their checkpoint scope.

Date: 2026-09-30. This is a read-only comparison of the frozen deployed-baseline source and the complete candidate used by the final measurement. No new test, profile, load experiment, product change or deployment was performed. The [final measurement](./source-optimization-results.md) remains the quantitative evidence: paired CPU p50 median +2.405 ms (+25.25%), CPU p95 +26.99%, and unresolved memory/client-tail crossings.

The comparison identifies concrete additional work. It does **not** establish how much of the 2.405 ms each operation consumes, or prove that the remaining gap is unavoidable. The A/B comparison includes all changes since the deployed baseline; it does not isolate the final `cdd2eb5c` optimization commit.

Source roots used below:

- A: `/Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/baseline`
- B: `/Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/p0-repair/source-optimization-ci-03`
- Package paths below are relative to `vnext/packages/` in those roots. B includes the preserved collaboration overlay.

## What the ordinary fixture actually exercises

The qualified `full-node-01` run contains one approximately 64 KiB user input, Responses to a custom Responses upstream, JSON/SSE modes, and a short `BENCH_OK:65536` result. It does not generate a large output or hundreds of logical frames. The initial and final retention readbacks are 0/0: numeric-zero dump retention enables capture, while numeric-zero Responses retention disables the reusable snapshot writer. The dump value is not an assertion of unlimited retention.

There are three custom upstreams and 21 configured models using direct fetch. No owned opaque input, encrypted output, tool continuation, compaction or protocol translation is exercised. The ordinary wrappers have the same source other than their two product import paths; no profiling/completion-wait wrapper was inserted into the measured request path.

## 1. Upstream diagnostic bodies add a complete representation pipeline

This is the clearest new work that grows with input size. Both A and B already read/parse the client request, prepare its dump, and store a canonical response dump. B additionally captures the actual upstream exchange, which has a different meaning from the client-facing records.

| Successful capture-enabled path | A | B |
| --- | --- | --- |
| Count/encode upstream request body prefix | Absent | Count full prepared text, encode up to 64 KiB |
| Observe upstream response bytes | Absent | Demand-driven stream wrapper, count/copy bounded prefix |
| Upstream prefix to Base64, envelope JSON, gzip | Absent | Required by current sidecar format |
| Dump R2 object writes | 2 | 3 |
| Dump SQL statements | Stage + row insert | Stage + row insert |
| Rows in the stage statement | 2 | 3 |

For this fixture the additional input pipeline is approximately:

`prepared upstream JSON -> 64 KiB prefix bytes -> 87,384 Base64 characters -> envelope JSON -> gzip -> third R2 object`

The input string already exists for the provider request. The additional byte counting, prefix encoding, Base64 generation, envelope serialization and compression are real work even after redundant copies are removed. The response is short, so the request side is the relevant size-dependent part here.

B anchors: `gateway/src/data-plane/providers/registry.ts:292`, `provider-custom/src/provider.ts:219`, `dial/src/fetcher.ts:401`, `gateway/src/shared/dump/upstream-attempts.ts:286`, `:308`, `:373`, and `gateway/src/repo/dump-store.ts:180`, `:203`, `:247`, `:269`, `:302`. A's two-file path is `gateway/src/repo/dump-store.ts:141` through its row insertion at `:189`.

The completed optimization batch already uses native bounded encoding, owned-prefix transfer, single-buffer Base64 views, trusted-envelope reuse, stage-specific release and bounded upload overlap. It is incorrect to list duplicate envelope projection, validation-only Base64 decoding or retained consumed prefixes as still-unimplemented fixes.

Consequently, the larger remaining opportunity is the capture contract or representation, not another round of small reference-release changes. Separating canonical dump capture from upstream-body capture could make diagnostic detail an explicit policy. Keeping full upstream capture while changing its Base64/JSON representation would require a versioned storage design and old-reader compatibility. Neither change should silently reduce current diagnostic content or be included in a performance comparison with changed features.

## 2. Correctness boundaries add fixed and per-event work

B adds affinity preparation/materialization, execution identity tracking, cancellation ownership, canonical terminal validation and output reconciliation. These are useful guarantees, but they create objects, maps, promises, stream wrappers and additional event checks on an ordinary request too.

- The affinity path creates a canonical container snapshot and an attempt-specific container copy. `gateway/src/shared/affinity/input-copy.ts:13` walks properties with a Map/stack and descriptor checks. Immutable strings are reused. The fixture has one long string in a small object graph; this is **not two extra 64 KiB string copies**. The previous large-string cloning defect has already been repaired.
- `gateway/src/data-plane/shared/affinity-request.ts:113` wraps transport with an AbortController/listener and a demand-driven stream. Ordinary requests still pay this lifecycle cost even though owned input is absent.
- `gateway/src/data-plane/chat-flow/responses/turn.ts:393` owns another event loop with terminal-tail checks, `ResponsesFinalOutput`, affinity egress and completion state. The upstream and post-transformation terminal observers protect different boundaries; removing one without preserving both checks changes failure semantics.
- `gateway/src/shared/affinity/egress.ts:132` maintains output identity maps and performs per-item checks. Plain text takes the early return at `:147`, before codec loading, serialization for the signing cache or encryption.
- The compaction shim scans input items and currently constructs a temporary rewritten array even when nothing changes (`gateway/src/data-plane/chat-flow/responses/interceptors/with-responses-compact-shim.ts:116`). This is item-count work; the single-item fixture does not support treating it as a major body-sized cost.

The old JSON route already synthesized in-memory protocol frames and reconstructed a final response. B did not newly introduce HTTP SSE encode/decode for JSON. Its additional cost is richer validation and lifecycle ownership around that existing event flow. Likewise, the final batch already fixed repeated abort-listener setup, redundant JSON delivery serialization, unbounded emitters and quadratic output matching; those are historical findings, not current explanations.

These fixed costs plausibly contribute to the residual CPU, but the short-output fixture provides no evidence that per-frame overhead is the dominant contributor. A future consolidation should preserve cancellation, late errors, isolated attempts and final-output authority while reducing duplicate observation or lifecycle machinery.

Three narrower simplification candidates remain visible in the ordinary path:

- `gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts:95` unconditionally initializes the Chat-only finished-choice Set, usage-tail array and usage-draining generator function. At `:136` it checks nonterminal events for Chat usage shape before the protocol check at `:141`. Responses does not need that Chat-specific state or shape check. Protocol-specific or lazy initialization can preserve Chat usage-tail semantics while avoiding this work elsewhere.
- The same iterator loop observes natural EOF at `upstream-telemetry.ts:115`, then still awaits `closeStream(iterator)` at `:167`. The canonical loop likewise observes EOF at `responses/turn.ts:405`, with source/raw-iterator cleanup at `:324`. `shared/stream-tail.ts:89` creates a Promise race and a timer for bounded cleanup even when an iterator has already finished; the timer is promptly cleared, not routinely waited out. Tracking natural exhaustion may avoid unnecessary cleanup wrappers, provided nested iterator ownership, cancellation and hung-return protection remain intact.
- Plain affinity egress still uses shallow copies, identity Maps and async/Promise wrappers around output that needs no mutation. A no-change path could reuse objects after required checks. Unknown upstream output must still be inspected for opaque content and correct ownership; disabling inspection for plain input would not preserve the contract.

These are small, source-confirmed candidates for removing unrelated or redundant work. They are not evidence that such edits alone recover the full 2.405 ms.

## 3. One small repeated setup cost is confirmed; several suspected costs are absent

B `gateway/src/data-plane/providers/registry.ts:288` first builds a request fetcher factory for all visible upstreams, then at `:316` builds an authoritative factory for each accepted upstream. With this fixture's three upstreams, B constructs four factories versus A's one (`registry.ts:331`). `gateway/src/data-plane/dial/per-request.ts:40` allocates maps/sets for each. Direct-only configuration returns early in `dial/src/proxy-catalog.ts:29`, so this does not mean four proxy SQL reads or URL parses.

This is a concrete duplication candidate. However, the eager factory also establishes global initialization/error ordering, while the accepted factories use authoritative catalog/configuration observations. Simply making the first call lazy or reusing it for accepted rows can change error timing or authority. A safe refactor must preserve those boundaries. For three direct upstreams, its magnitude remains unknown and likely cannot be inferred from construction count alone.

Important exclusions from this fixture's explanation:

- HTTP authentication and `ConfigurationCache` pinning/lease behavior remain substantially the same. The new WebSocket fresh-view path is not used.
- Warm B catalog lookup returns memoized state (`catalog-coordinator.ts:102`, `:142`) without D1 or a configuration hash. A computed a SHA-256 cache key even before a warm hit (`registry.ts:195`, `:237`). Some new code therefore removes work rather than adding it. Cold/expired catalog refresh costs must be considered separately.
- Both versions already construct providers and project the 21 model bindings per request. That entire cost is not a new regression.
- No owned marker means no input codec load/decryption and no per-candidate affinity preparation. The custom provider captures execution identity without an additional authority repo read on this path. Plain-text output does not load the codec or encrypt.
- Responses snapshot retention is off, so snapshot persistence and its input-history clone are not ordinary fixed costs here.
- Ordinary Responses uses `finalizeTurn`, not the generic canonical-dump response wrapper used by other protocols.

## CPU, client latency and isolate memory need different explanations

Cloudflare defines CPU time as active execution; waiting for network/database responses does not count. Its memory limit applies to the shared isolate, which can serve concurrent requests. See the [official limits documentation](https://developers.cloudflare.com/workers/platform/limits/) (source checked on 2026-09-30).

Therefore the third R2 write is not itself proof of 2.405 ms more CPU. Its encoding/compression/stream setup contributes computation; storage waiting affects completion lifetime and how long buffers/jobs can overlap.

Upstream telemetry yields its validated terminal at `upstream-telemetry.ts:153`; the canonical turn holds it and continues reading, so telemetry's `finally` and awaited `closeStream` at `:162` through `:167` finish before the canonical turn yields its terminal at `responses/turn.ts:437`. That cleanup is foreground work. The turn's final cleanup, telemetry persistence and dump completion at `turn.ts:321` are then owned by completion/`waitUntil` (`:471`) after the canonical terminal is yielded. The JSON renderer's delivery promise (`responses/respond.ts:24`) allows its HTTP response to return without waiting for completion. Canonical yield does not itself prove that SSE bytes have reached the client. Moving work after the delivery decision does not remove its CPU or allocation cost.

The ordinary paired client p50 is broadly unchanged despite higher sampled CPU. JSON p95 has adverse windows, but A's D1 primary was NRT and B's KIX, so client-tail differences cannot all be assigned to source. Worker CPU and client response time are not interchangeable measures.

The extra bounded capture and its transitional representations increase allocation pressure. They do not, by themselves, explain a roughly 26 MB worst paired memory increase. The reported value is a shared-isolate quantile; background-job overlap, runtime buffer lifetime and collection timing remain hypotheses. Earlier Inspector observations supported transient allocation pressure for an older candidate, not a demonstrated leak or a current-candidate causal attribution. No new heap conclusion is made here.

## Follow-up order

1. First remove protocol-irrelevant setup and confirmed duplication where contracts can be preserved: Chat-only scratch state on Responses, cleanup wrappers for naturally exhausted iterators, unchanged plain-output copies, no-op compaction arrays and repeated fetcher construction. Preserve terminal validation, nested cleanup ownership, cancellation and authoritative configuration/error ordering. These are candidates, not implemented fixes or a promise to recover the whole CPU gap.
2. Separately evaluate the larger architectural choice: should canonical request/response dumps and upstream raw-body diagnostics remain inseparable for every capture-enabled request? This is the clearest size-dependent cost lever and requires an explicit feature-policy decision, not a silent optimization.
3. If identical diagnostic content remains required, evaluate the sidecar representation and streaming preparation with format/rollback compatibility included. Do not substitute more queues or compression concurrency for reduced work, or promise a saving before a complete candidate is measured.
4. Quantify the next complete implementation batch under unchanged comparison conditions. Keep current adverse results, artifact/placement boundaries and rollback gates. No per-item load campaign is needed merely to document these source findings.

This analysis does not close resource or release acceptance. Development-branch integration and production rollout remain separate decisions.
