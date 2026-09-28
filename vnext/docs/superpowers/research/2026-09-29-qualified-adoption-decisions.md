# Qualified Reference Adoption Decisions

Date: 2026-09-29 (Asia/Shanghai). Scope: research and isolated verification, with no application implementation or deployment.

Tracking index: [Reference adoption follow-up](../plans/2026-09-29-reference-adoption-follow-up.md).

## Baselines and evidence boundaries

- vNext: `e6780380002809a97981af994347485ebce52e29`, plus the existing uncommitted collaboration-shim work. That work was preserved.
- Reference: `/Volumes/Projects/copilot-gateway`, `1d7dcd923e260e425120cca0c7a240e93720af27`.
- Codex client source: `/Volumes/Projects/codex`, `8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f` (2026-09-03). Client conclusions apply to this source version, not every released client.
- Local shell: Bun 1.3.0 and Node 22.23.2. The running local deployment image uses Bun 1.4.2. Memory experiments used disposable, network-disabled containers from that image, not the running service.
- No paid inference, real-account compaction, production disconnect test, or Workers heap measurement was performed. Source proof, mocks, local network observations, and memory microbenchmarks are distinguished below.
- Paths beginning `packages/` or `apps/` refer to `vnext/`; reference paths are explicitly marked.

## Decisions

| Topic | Decision | Concrete follow-up |
|---|---|---|
| E01: Responses WebSocket | Adopt truthful capability/configuration; conditionally implement ingress WS | Correct declarations first. Design shared execution, authorization, terminal ordering, continuation and cancellation before enabling WS. Defer native upstream WS and multiplexing. |
| E02: Native compaction plaintext recovery | Do not port directly or enable by default | Treat model replay only as an experimental portable-summary conversion. Adopt deterministic envelope/window fixes independently. |
| E03: Client disconnect | Preserve cancellation; fix incomplete propagation and records | Repair Custom/Azure/SDF signal forwarding and timeout composition, cancellation classification, and snapshot completeness. Do not reinstate unbounded background drain. |
| E04: Existing coverage and memory | Reuse verified existing features; adopt opaque chunking | Avoid redundant GHE/cache/maintenance implementations. Opaque chunking has relevant Bun evidence. Blob leak claims remain runtime-specific. |

## E01: Responses WebSocket

### Current behavior and actual client gating

vNext exposes HTTP POST Responses routes (`packages/gateway/src/data-plane/routes.ts:46`) and the Bun server has no WebSocket upgrade adapter (`apps/platform-bun/src/server.ts:28`). Codex and Copilot upstream execution also uses HTTP POST (`packages/provider-codex/src/fetch.ts:482`, Copilot `forward.ts:79`). VLESS WebSocket transport in the proxy package is unrelated to the Responses application protocol.

An in-memory gateway/SQLite probe returned **404** for GET plus Upgrade on `/responses`, `/v1/responses`, and `/azure-api.codex/responses`. The catalog synthesis probe returned `prefer_websockets:true` when no catalog matched, and preserved matched true/false values (`packages/gateway/src/data-plane/codex/synthesize.ts:57,123`). There is therefore a capability mismatch, but its client impact requires qualification.

The inspected Codex client gates WS on `provider.supports_websockets` and session fallback state (`codex-rs/core/src/client.rs:1049`). It has no production Rust consumer of model `prefer_websockets`; the old WS feature flags are removed (`codex-rs/features/src/lib.rs:1679,1685`). Custom provider `supports_websockets` defaults to false, while the built-in OpenAI provider sets it true (`codex-rs/model-provider-info/src/lib.rs:145,418`). **The catalog field alone does not cause every current Codex client to use WS.**

This client immediately falls back to HTTP on a 426 upgrade response (`client.rs:1803`). A 404 takes the ordinary error/retry path (`client.rs:1825`, `responses_retry.rs:85`), which can eventually fall back for the session. No real-client end-to-end fallback or user configuration was tested; older release behavior remains unverified.

### Adoption boundaries

1. While WS is absent, synthesized catalogs should report that fact, including matched upstream models: upstream capability does not prove gateway ingress capability.
2. Generated/recommended custom-provider configuration should explicitly use `supports_websockets=false`. Catalog correction is not a substitute for current-client provider configuration.
3. Evaluate a narrowly scoped unsupported-upgrade 426 response with client-version tests. Do not blanket-change ordinary GET routes on this evidence alone.
4. A first WS implementation can bridge client WS to the existing upstream HTTP/SSE execution. It needs an execution abstraction below the current HTTP `Response` wrapper (`packages/chat-flow-kit/src/serve-template.ts:164`), not a text-level SSE wrapper.

Acceptance requirements from reference commits `67b5db157`, `81ad72ea5`, `e929bd339`, and `56dddc6dc`:

- Reauthorize each turn and preserve key/owner/model boundaries throughout a long-lived connection.
- Commit enabled continuation storage before the terminal success frame; terminal is the last frame for that turn.
- Evict failed continuation state, bound queues/backpressure, and cancel the active upstream on disconnect.
- Keep cancellation, `finally`, dump and usage cleanup within session lifetime; do not keep generation alive merely for telemetry.
- Use protocol-safe keepalive and bounded connection-local state. Connection-local `store:false` state is not durable cross-connection retention.
- Verify `generate:false` warmup performs no inference. Explicitly reject unsupported multiplexing rather than processing it with a single undifferentiated queue.

The current [official WS guide](https://developers.openai.com/api/docs/guides/websocket-mode) includes multiplexing/fork and `stream_id` behavior. The reference implementation is a single queue, so copying it does not establish support for the complete current contract. Bun native upgrades and CFW WebSocketPair also require platform-specific adapters. Native upstream WS, lane scheduling, fork, and reconnect persistence remain separate designs.

## E02: Native compaction plaintext recovery

### What the reference actually does

Reference `packages/gateway/src/data-plane/chat/openai-responses/interceptors/compact-shim.ts:430–499` first performs native compact, then makes a serial generation call for every returned compaction item. Each replay contains an exact-repeat instruction, one opaque item, another instruction, `model`, and `store:false`.

It drops original tools, retained neighboring items, instructions, reasoning, service tier, and output budget from the replay. The selected candidate/provider remains the same, but this does not guarantee the same raw model variant or account: Copilot can derive the raw variant again from now-omitted effort/tier, and Codex rereads the active account.

The replay text replaces only `encrypted_content`; other collected output items and fields remain in order. The replacement is a base64url JSON user-message envelope, **not encryption**. The original opaque content is not retained. On subsequent expansion, the compaction identity and extra fields disappear into text. Recognition is structural and lacks a version/authentication marker. The terminal-only native collector also inherits the risk of losing closed items absent from terminal output.

The [official compaction guide](https://developers.openai.com/api/docs/guides/compaction) treats opaque compacted state as non-inspectable and the whole returned compacted window as canonical continuation context. Model-generated reproduction cannot prove equivalence to that state.

### Failure reproduction

An algorithm-level mock extracted the actual reference shim/collector/reassembly/usage logic, with dependency and event helpers mocked (`/tmp/e02-compaction-mock.ts`). This is not provider integration.

| Replay result | Observed converted result |
|---|---|
| `incomplete` with `PARTIAL` text | Accepted; original native success retained, truncation lost |
| `failed` with `PARTIAL` text | Accepted; original native success retained, error lost |
| Completed whitespace | Accepted |
| Completed unrelated text | Accepted |
| Completed empty string | Throws |

The only text gate is `text.length === 0` (`compact-shim.ts:468`). Final assembly spreads `nativeResponse`, not the replay status. API/internal errors return and exceptions throw; there is no fallback returning the original native window. Outer candidate retry may repeat the native-plus-replay sequence elsewhere.

For N opaque items, happy-path work is **1 native compact plus N serial generation calls**, without a dedicated item/token/time budget. Authentication retries/failover can add requests. Aggregate usage plus a single surviving pricing tier cannot faithfully price calls across different tiers; earlier successful subcall usage can also be lost if a later replay fails. Per-subcall accounting is required.

### Recommended split

Do not directly port this path or call it lossless decryption. An experimental, default-off portable-summary conversion would require a provider allowlist, compatible raw variant/account handling, successful nonblank non-refusal nontruncated replay, call/token/time bounds, atomic replacement, original-window rollback with affinity, and per-call usage/cost records. These conditions still cannot guarantee semantic equivalence.

The existing vNext ordinary compact shim generates a summary directly (`with-responses-compact-shim.ts:198–280`) and preserves that generation's failed/incomplete status (`:168–171`); it does not have the reference's native-success masking. Preserve this distinction.

Independent deterministic improvements are worth adopting:

- Recognize `compaction_summary` as well as `compaction` (`with-responses-compact-shim.ts:107`).
- Expand recognized own-format envelopes before flag gating: current expansion occurs after an early return (`:291–298`), allowing an existing gateway envelope to reach a native target when the shim is disabled. Foreign opaque values must remain opaque.
- Preserve the full compact output and implement atomic compact-window replacement. The current store bridge always appends input plus output (`packages/gateway/src/data-plane/dispatch/responses-store-bridge.ts:56`).
- Distinguish explicit `/responses/compact`, which currently skips compact snapshot storage (`responses/http.ts:76`), from compact-trigger continuation. Do not change retention semantics accidentally.

## E03: Client disconnect, cancellation and cleanup

### What the reference history establishes

| Reference commit | Explicit behavior/rationale |
|---|---|
| `8602f8825` | Detached dispatched generation from client cancellation to finish usage, dump, and performance; acknowledged CFW's limited cleanup lifetime. |
| `41bc40813` | Added a 15-minute drain budget because a never-ending drain could pin sockets and resources indefinitely. CFW could stop earlier. |
| `68e3b1c58` | Reverted both changes and restored cancellation to provider/body/tools/images. Its message does not establish a deeper billing or product rationale. |
| `56dddc6dc` | Kept a WS cleanup chain alive until turn `finally` had registered background writes. This fixes cleanup lifetime, not continued generation. |

The adoption decision is to retain cancellation semantics and the cleanup-lifetime principle, not the retain/drain implementation. [OpenAI's background guide](https://developers.openai.com/api/docs/guides/background) separates synchronous connection cancellation from explicit background execution with polling/resumption/cancellation. `store:true`, dumps, or `waitUntil` do not provide that task protocol.

### Verified gaps in vNext

**Signal propagation is incomplete.** Custom passes `req.signal` into `send` (`packages/provider-custom/src/provider.ts:171`), but reconstructs `fetchWithRetry` arguments without it (`:240`). Azure has the same omission (`packages/provider-azure/src/provider.ts:240`); SDF also omits `req.signal` (`packages/provider-sdf/src/provider.ts:218`). Independently, `packages/http/src/fetch-retry.ts:40–45` replaces the caller's signal when a timeout controller exists, instead of composing them.

A real localhost HTTP experiment used Bun 1.3.0, two local servers, in-memory SQLite and synthetic SSE. The client aborted after `response.created`; observations were taken 1.5 seconds later. The control changed only signal forwarding in a temporary script, not repository code.

| Observation | Current Custom path | Temporary signal-forwarding control |
|---|---:|---:|
| Upstream request abort events | 0 | 1 |
| Upstream socket close events | 0 | 1 |
| Performance outcome | cancelled | cancelled |
| Dump persisted | yes | yes |

Thus recorded cancellation does not prove network cancellation. Azure/SDF omissions are source evidence; only Custom received this real-network reproduction. Socket closure does not prove a remote provider stopped billing.

**Cancellation classification is incomplete.** The experiment persisted a 194-byte dump with `error:null` despite cancelled performance. Responses persistence tests `state.failed` rather than cancellation (`responses/respond.ts:143,202,248`); the SSE parser can return normally on abort (`packages/result/src/parse-sse.ts:48`). Add an explicit cancellation outcome rather than calling every cancellation an upstream error.

**Snapshot completeness is unspecified.** With only `response.created` and no terminal event, the same experiment saved an input-only snapshot under `resp_local_cancel`. The sidecar requires a response ID but not a confirmed terminal state (`responses/snapshot-sidecar.ts:40,54`). Decide whether interrupted turns are rejected for continuation or stored with explicit partial status; an unmarked partial snapshot must not masquerade as a complete post-turn state. This does not require continuing generation after disconnect.

### Existing correct foundations to preserve

- `ClientDisconnect` combines inbound abort and response-body cancellation, including the tee case (`chat-flow/shared/client-disconnect.ts:3`).
- Dump capture/write and snapshot sidecars register their background work before returning (`shared/dump/accumulator.ts:200`).
- Persistence is idempotent, and cancellation does not await potentially unsettled `finalMetadata` (`chat-flow/shared/respond-telemetry.ts:72`).
- CFW binds background execution per request with AsyncLocalStorage (`apps/platform-cloudflare/src/worker.ts:11`); interleaving tests passed. Bun catches fire-and-forget work (`apps/platform-bun/src/bootstrap.ts:42`) but cannot guarantee survival of a process crash.
- Existing usage observers can preserve observed usage. Missing terminal usage remains unknown/partial; do not invent a final bill or keep generating solely to obtain it.

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) permit `waitUntil` extension for up to 30 seconds after response/disconnect. Cleanup should settle within that budget; durable background generation needs a separately designed execution owner.

## E04: Existing capabilities and runtime applicability

### Existing behavior worth retaining

| Area | Current evidence | Remaining work |
|---|---|---|
| GitHub Enterprise | Copilot host/advertised endpoint and refresh-related regression coverage passes | No real enterprise-account end-to-end verification; avoid rebuilding existing support. |
| Catalog outages | Mock-isolate L1/L2 stale catalog test preserves aliases and inference | Cross-instance refresh coordination/version fences/backoff remain useful. |
| Final usage | Include-usage wiring and observer tests pass | Continuous/progressive usage is a distinct enhancement; preserve unknown counters. |
| Responses cleanup | Real SQLite retention/renewal/backlog/disabled/orphan tests pass | Capacity/lease evaluation and dump/spilled-file cleanup are separate gaps. |
| Compact baseline | Own/foreign envelope and route regressions pass | They do not cover E02's alias, flag-off expansion and compact replacement gaps. |
| Performance filters | Pure aggregation/filter tests pass; source keeps filter state separate from data refresh (`apps/dashboard/src/state/performance.ts:18`) | Refresh persistence was not browser-tested; multi-select is incremental. |

### Opaque reconstruction: relevant runtime benefit reproduced

The reference chunked `rawStringFromBytes` keeps the raw UTF-16 wire codec while avoiding per-character retained string structures. The experiment extracted each repository's exact function, warmed up, retained 64 strings of 6,144 UTF-16 code units (393,216 total), forced GC and sampled **before** equality checks could flatten string structures. It then checked equality and preservation of all 65,536 UTF-16 code units, including BOM and lone surrogates. Three separate processes were used for each mode/runtime.

| Runtime | Current retained heap delta | Reference retained heap delta |
|---|---:|---:|
| Bun 1.3.0, local | 12,584,818–12,586,229 bytes | 397,589 bytes |
| Bun 1.4.2, isolated deployment image | 12,585,793–12,585,857 bytes | 396,675–397,315 bytes |
| Node 22.23.2, local | 12,560,440 bytes | 391,344 bytes |

Use JSC `heapStats().heapSize` for Bun (Bun 1.3's `process.memoryUsage().heapUsed` delta misleadingly reported zero), and `heapUsed` for Node. This shows roughly 12 MiB versus 0.38 MiB of retained heap for this fixture. External allocations and RSS differ, and this is neither a production total-memory reduction claim nor proof of a leak. It supports adopting bounded chunking (B04) with codec regressions. Workers remains unmeasured.

### Blob gzip: runtime-specific conclusion

Reference `f1a4fcb2e` reported Blob retention on Node 24.16–24.18; its deployed Node 22.23.1 was already flat. That does not prove a Bun/Workers leak.

The actual vNext gzip path (`packages/gateway/src/repo/dump-store.ts:80–104`) uses `new Blob([bytes]).stream()` whenever `CompressionStream` exists. Local Bun 1.3.0 lacks it and falls back to `Bun.gzipSync`; the deployed Bun 1.4.2 exposes it and enters the Blob branch. Inferring production behavior from the host executable alone would therefore be wrong.

The accompanying bounded gzip experiment compares Blob and direct ReadableStream sources using fresh 256 KiB random payloads: 10 warmups, then 400 serial operations with post-GC samples every 100 operations. Bun 1.4.2's Blob heap stayed around 735–738 KB after warmup and external memory around 239–242 KB; RSS fluctuated and finished below its initial sample. Direct stream was similarly bounded. Node 22's external/ArrayBuffer counts stayed flat in both modes; RSS increased in both, more for Blob, so allocator/native memory still warrants longer profiling if operational symptoms demand it. This workload did **not** reproduce the reported sustained Bun Blob retention pattern; it does not prove leak absence.

Results and reproduction commands are stored with the evidence below. This is a screening experiment, not a long-duration leak qualification. No Workers/production heap trend was measured. Keep B06 conditional and do not port reference double-clone machinery absent from vNext.

Workers has 128 MB per isolate shared across concurrent requests ([official limits](https://developers.cloudflare.com/workers/platform/limits/)); Node/JSC microbenchmarks cannot quantify production isolate headroom. A prior memory incident informed the decision to separate peak allocation from retained growth, but that incident was not revalidated in this investigation.

## Verification and evidence

Focused existing tests: **222 passed, 0 failed** across four runs (49 + 31 + 91 + 51). These are focused regressions, not full CI or production acceptance. Tests named “real transport” in the existing suite use mocked fetch; the separate E03 experiment observes actual local sockets.

Run from `vnext/`:

```sh
bun test packages/gateway/tests/integration/catalog-outage.test.ts packages/gateway/tests/integration/include-usage-wiring.test.ts packages/gateway/tests/responses-maintenance.test.ts packages/gateway/tests/control-plane-auth-github.test.ts apps/dashboard/src/state/performance.test.ts packages/gateway/tests/data-plane/chat-flow/responses/interceptors/with-responses-compact-shim.test.ts packages/protocols-llm/src/common/__tests__/opaque-value.test.ts
bun test packages/provider-copilot/__tests__/plugin.test.ts packages/provider-copilot/src/__tests__/injected-fetcher.test.ts packages/gateway/tests/shared/copilot-token-cache.test.ts packages/gateway/tests/responses-compact.e2e.test.ts
bun test packages/gateway/tests/integration/streaming-performance.test.ts packages/gateway/tests/data-plane/chat-flow/chat-completions/respond.test.ts packages/gateway/tests/shared/external-image-loader.test.ts packages/platform/tests/background.test.ts
bun test packages/result/__tests__/parse-sse.test.ts packages/gateway/tests/responses-snapshot-id-roundtrip.test.ts packages/gateway/tests/performance-metrics-observer.test.ts
```

Preserved evidence: [experiment files and reproduction notes](./2026-09-29-qualified-adoption-evidence/README.md). Official pages were retrieved on 2026-09-29. No application code was changed by this investigation, and full `ci:local` was not run for this documentation-only delivery.

## Next implementation order

1. Fix signal propagation/composition (B09), explicit cancelled/partial outcomes (A13), and accurate WS capability/configuration (C11).
2. Adopt opaque chunking (B04), alongside existing correctness work A01–A10 and D01. Memory benefit is now measured on the deployed Bun version.
3. Implement deterministic compact envelope/window handling (A14), coordinated with output reconstruction and durable snapshot ordering (A02/A03).
4. Design client-facing WS (C12) only after continuation terminal ordering is sound. Keep native compaction replay and Blob leak remediation experimental/conditional until their missing evidence or contracts are resolved.
