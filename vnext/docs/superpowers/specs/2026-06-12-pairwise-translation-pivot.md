# Pairwise Translation Pivot — Architecture Design

**Status:** Draft
**Date:** 2026-06-12
**Branch:** `vNext` (long-lived, one-shot migration — no staged coexistence)

---

## 1. Motivation

The current vNext architecture funnels every conversation request through a **unified IR** (`@vnext/protocols/ir`):

```
client payload → FrontendAdapter.toIR → IRRequest
              → BackendAdapter.toUpstream → upstream call
              → BackendAdapter.decodeSSE/decodeBody → IREvent stream
              → FrontendAdapter.encodeSSE/encodeBody → client response
```

IR was meant to be a "Maximum Common Denominator" so any frontend protocol could pair with any backend protocol via two adapters. In practice it has produced friction:

1. **Provider extensibility is coupled to the IR vocabulary.** Adding a feature that exists in one provider but not others (Anthropic `redacted_thinking`, OpenAI `reasoning.encrypted_content`, future provider-specific blocks) requires growing IR — every new field forces every other adapter to either ignore or re-encode the addition.
2. **First-class providers carry second-class features.** Cache breakpoints, citations, signed-reasoning round-trip — these all degrade through IR's lossy intersection. Making them lossless requires per-pair logic anyway, defeating the unification.
3. **IR is the wrong abstraction for the gateway's actual goal.** The gateway is a **routing + translation hub**, not a cross-vendor protocol normalizer. Users want `client X ↔ provider Y` pairs to be high-fidelity; they do not benefit from a synthetic intermediate language.
4. **Pluggability suffers.** A new provider must implement an N×2 adapter conformance to IR. We want a new provider to be a single pluggable module that ships its own native protocol code and reuses pairwise translators.

**Established principle (user):** *"可插拔，模块内聚独立是第一原则" — independent extensibility is the first principle.*

---

## 2. Architecture

### 2.1 Hub Protocol: Messages (conversation endpoints only)

For the four conversation endpoints — `chat_completions`, `messages`, `responses`, `gemini` — we adopt **Anthropic Messages as the internal hub protocol**.

```
chat client      ─┐
messages client  ─┼─ pairwise translator (client → Messages) ─┐
responses client ─┤                                            ├─ Messages-native call ─→ provider
gemini client    ─┘                                            │
                                                                │
                  ┌─ pairwise translator (Messages → client) ─┘
```

**Why Messages, not IR:**
- It is a real, externally-validated protocol — no intersection language to design or evolve.
- It is the highest-fidelity protocol for the most expressive feature (extended thinking, signed reasoning, cache breakpoints) we currently route, so down-conversions lose information predictably while up-conversions stay clean.
- For a `messages → messages` request (Anthropic SDK → Anthropic upstream), translation is **identity / pass-through** — the hub is the native protocol.

**Hub scope is strictly conversation endpoints.** The following endpoints **bypass the hub**:
- `embeddings` — frontend → provider direct (no protocol translation needed).
- `images_generations` / `images_edits` — frontend → provider direct.
- `messages_count_tokens` — Anthropic-only endpoint, frontend → provider direct.

These endpoints do not go through Messages because there is no second client protocol to translate to/from.

### 2.2 Pairwise Translators

Six translator modules cover all client↔hub pair directions:

| Module | Direction | Purpose |
|---|---|---|
| `chat-completions-via-messages` | request: chat→messages, events: messages→chat | OpenAI-compatible client over Messages backend |
| `messages-via-chat-completions` | request: messages→chat, events: chat→messages | Anthropic client over OpenAI-Chat backend |
| `responses-via-messages` | request: responses→messages, events: messages→responses | OpenAI Responses client over Messages backend |
| `messages-via-responses` | request: messages→responses, events: responses→messages | Anthropic client over OpenAI Responses backend |
| `gemini-via-messages` | request: gemini→messages, events: messages→gemini | Gemini client over Messages backend |
| `messages-via-gemini` | request: messages→gemini, events: gemini→messages | Anthropic client over Gemini backend |

**Messages-native fast path:** when client = messages and chosen target endpoint = messages, no translator runs — payload and events flow through unchanged. This must be a code path, not a no-op translator instance, so observability and provider invocation see identical signatures.

Each translator module exports:
- A request mapper: `(clientPayload) → messagesPayload` (or the reverse).
- An async event mapper: `(AsyncIterable<UpstreamEvent>) → AsyncIterable<ClientEvent>` for SSE.
- A non-streaming body mapper: `(upstreamBody) → clientBody`.

Translators **never see HTTP**; they consume and produce typed protocol values and AsyncIterables. `ReadableStream<Uint8Array>` lives only at the HTTP boundary in the gateway entry/exit.

### 2.3 ModelProvider Interface

`provider-copilot` already implements `ModelProvider`. We formalize the contract so any provider plugs in identically.

```ts
interface ModelProvider {
  readonly kind: string                   // 'copilot' | 'azure' | ...
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]

  getModels(): Promise<Model[]>
  probe(): Promise<ProbeResult>

  // Per-endpoint methods (only those listed in supportedEndpoints exist)
  callChatCompletions?(payload, opts): Promise<UpstreamResponse>
  callMessages?(payload, opts): Promise<UpstreamResponse>
  callResponses?(payload, opts): Promise<UpstreamResponse>
  callMessagesCountTokens?(payload, opts): Promise<UpstreamResponse>
  callEmbeddings?(payload, opts): Promise<UpstreamResponse>
  callImagesGenerations?(payload, opts): Promise<UpstreamResponse>
  callImagesEdits?(payload, opts): Promise<UpstreamResponse>
}
```

`UpstreamResponse` is a discriminated union: `{ ok: true, status, body: AsyncIterable<RawEvent> | UpstreamJson }` or `{ ok: false, status, error: HTTPError }`. `ProbeResult` is the existing shape from current `provider-copilot`. The provider takes ownership of: HTTP, retry, headers, auth, transport-level errors, and **native protocol parse** (raw bytes → typed events / typed body). The provider returns typed protocol values, not Response objects.

**Why per-endpoint methods (not a single `fetch(endpoint, ...)`):** type signatures differ meaningfully — `callMessages` carries `anthropicBeta`, images split generations vs edits, count_tokens has a distinct payload shape. A union/discriminated `fetch()` collapses these into `unknown` and pushes type errors into translators. Per-endpoint methods keep types tight at the boundary.

### 2.4 Provider Plugin Registration

```ts
// gateway: providers/registry.ts
const providerFactories: Record<string, ProviderFactory> = {
  copilot: createCopilotProvider,
  // azure: createAzureProvider,
  // codex:  createCodexProvider,
}
```

The gateway never imports a concrete provider. New providers are added by registering a factory; the gateway is provider-agnostic.

### 2.5 Server-Tools Plugins

`web-search` (Messages, multi-turn loop) and `image-generation` (Responses → image backend) remain **pre-dispatch short-circuit handlers** at the route layer:

```
POST /v1/messages   → if hasWebSearch(raw) → handleMessagesWebSearch  (return)
                    → else → dispatch via pair (messages → target)
POST /v1/responses  → if hasImageGeneration(raw.tools) → handleResponsesImageGeneration  (return)
                    → else → dispatch via pair (responses → target)
```

These intercepts run their own multi-turn or single-shot logic against an image/Messages backend; they do not flow through the conversation pair pipeline. They invoke `ModelProvider.callMessages` / `callImagesGenerations` directly. Observability is added via the same gateway-layer attempt modules used by the regular dispatch path (see §2.6) — there is no separate observability story for these handlers.

### 2.6 Observability: Gateway-Layer Attempt Modules

Observability (`checkQuota`, `recordLatency`, `trackStreamingUsage`, `trackNonStreamingUsage`, `detectClient`) currently lives in `routes.ts dispatch()`. We extract per-endpoint **attempt modules** at the gateway layer:

```
gateway/observability/attempts/
  conversation-attempt.ts   // chat / messages / responses / gemini
  embeddings-attempt.ts
  images-attempt.ts
```

An attempt module wraps a single upstream call:

```ts
async function runConversationAttempt(opts: {
  apiKeyId, model, sourceApi, targetApi, userAgent, requestId,
  call: () => Promise<UpstreamResponse>,
  onStream?: (stream) => stream,
}): Promise<UpstreamResponse>
```

It handles: pre-call quota check, timer start, latency record on success/error, streaming-usage tap, non-streaming-usage tap. The dispatch loop becomes:

```ts
const attempt = await runConversationAttempt({ ..., call: () => provider.callMessages(payload, opts) })
```

**Why not a Provider decorator:** decorating a `ModelProvider` with observability requires a single composed signature. Per-endpoint methods have distinct types (anthropicBeta, image variants); a generic decorator either erases these or duplicates per-method, neither is clean. Gateway-layer attempts also keep providers stateless of business policy (quota, usage) — quota is a gateway concern, not a provider concern.

Server-tools plugins call attempt modules directly, so their observability story is identical (no bypass warnings).

---

## 3. Stream Cancellation Contract

Streams must propagate cancellation cleanly when the client disconnects.

**Contract:**
- The HTTP entry creates an `AbortController` linked to the request lifetime (Hono `c.req.raw.signal`).
- The signal is passed through every layer:
  ```
  HTTP entry → attempt module → ModelProvider.callX(payload, { signal })
            → fetch upstream with signal
            → AsyncIterable<RawEvent> (provider parser)
            → translator AsyncIterable<ClientEvent>
            → SSE encoder ReadableStream
  ```
- Translators must be `AsyncIterable` generators that propagate `try/finally` cleanup. When the consumer's `for await` terminates (downstream `ReadableStream.cancel()` fires), the generator must exit, which must release any upstream reader.
- Provider parsers own the upstream reader and **must** observe `signal.aborted` between chunks; on abort they release the reader and reject the iterable.
- Observability attempt modules record an aborted attempt as `isError: true` with a distinguished reason (`'client_abort'`), not as upstream failure.

**Test requirement:** every translator must have a "cancellation propagates" test using a paused upstream and a cancelled consumer.

---

## 4. Hub Protocol Versioning

Anthropic Messages evolves (new content block types, new event types, new tool shapes). Because Messages is the hub, upstream Anthropic changes can ripple into every translator.

**Mitigations:**
- The hub Messages type lives in `@vnext/protocols/messages` (not in `provider-copilot`). It is **gateway-internal** — frozen at a chosen version, evolved deliberately.
- The hub type is a **superset** of fields we route. Unknown fields from Anthropic upstream are passed through opaquely on the messages-native fast path; for translated paths, unknown fields surface as `opaque` blocks the target translator can drop.
- Each translator module pins which hub fields it consumes/produces. Adding a new block type requires touching every `*-via-messages` translator — this is intentional and visible, not hidden.
- A `HUB_VERSION` constant is recorded in latency metadata so observability traces tell us which hub vocabulary handled a request when we change it later.

**Out of scope (for now):** content-negotiation at hub level. We will not run multiple hub versions side by side.

---

## 5. Migration Strategy: One-Shot on Long Branch

`vNext` is the long-lived branch. We **do not** introduce a parallel pairwise pipeline alongside the IR pipeline — that intermediate state is more dangerous than a longer branch. Instead, sub-stages happen sequentially on `vNext`, each leaving the codebase compiling and passing the architecture-independent test set.

### Sub-stages

| # | Stage | Action |
|---|---|---|
| X-1 | Hub protocol package | Add `@vnext/protocols/messages` (the hub vocabulary). Don't wire yet. |
| X-2 | ModelProvider interface | Define formal `ModelProvider` per-endpoint methods in `@vnext/provider/types.ts`. `provider-copilot` adds the new `callX` methods alongside its existing `fetch(endpoint, ...)` — both work, gateway still uses `fetch()`. Switch happens in X-5. |
| X-3 | Pairwise translators | Add 6 translator modules in `@vnext/translate`. Pure functions / generators, no gateway wiring yet. Unit tests per pair. |
| X-4 | Attempt modules | Extract `runConversationAttempt`, `runEmbeddingsAttempt`, `runImagesAttempt` from current `dispatch()` into `gateway/observability/attempts/`. Keep current `dispatch()` calling them. Tests preserved. |
| X-5 | Switch dispatch to pairs | Rewrite `routes.ts dispatch()` to use pair selection + attempt module + provider per-endpoint method. Delete IR-based `backendForEndpoint`, `pickTarget`, `FrontendAdapter`/`BackendAdapter` invocations. |
| X-6 | Delete IR + old adapters | Delete `@vnext/protocols/ir`, `apps/gateway/src/data-plane/adapters/{frontend,backend}/`, all IR-dependent imports. |
| X-7 | Server-tools rewire | Update `web-search` and `image-generation` route-handlers to call attempt modules + ModelProvider directly. Remove "observability bypass" warnings. |
| X-8 | Test cleanup | Delete the 4 IR-dependent tests (`pipeline.test.ts`, `messages-out.test.ts`, `chat-out.test.ts`, `observability/dispatch-observability.test.ts`); ensure their coverage is preserved by the new pair tests. |
| X-9 | Test additions | Per-pair translator tests (request, events, cancellation), per-attempt-module tests, end-to-end pair tests for each client × provider matrix. |

Stage gates: each stage must end with `bun test` green for the architecture-independent tests (38 files). After X-5 the IR tests will fail; X-6 removes them; X-8/X-9 fill the gap.

**Stage parallelism:** X-1, X-2, X-3, X-4 are mutually independent — they add new code without removing old. X-5 is the **one-shot switch point** that transitions from IR to pairs. X-6 onward must be sequential.

---

## 6. File Layout (Target)

```
vnext/packages/
  protocols/
    src/
      messages/         # Anthropic Messages hub vocabulary
      common/           # EndpointKey, ModelEndpoints, etc.
      # ir/             ← DELETED in X-6
  provider/
    src/
      types.ts          # ModelProvider interface, UpstreamResponse, ProbeResult
      registry-types.ts # ProviderFactory
  provider-copilot/
    src/
      provider.ts       # implements ModelProvider with per-endpoint methods
      transport/        # forward.ts, headers.ts, retry, errors
      catalog/          # models, variants, endpoints, fetch-models
      parse/            # native SSE parsers per endpoint
      interceptors/     # existing
      transforms/       # existing
  translate/
    src/
      chat-completions-via-messages/
      messages-via-chat-completions/
      responses-via-messages/
      messages-via-responses/
      gemini-via-messages/
      messages-via-gemini/
      shared/           # cache-breakpoints, reasoning-pack, citations, etc.
  test-utils/
    src/
      mock-fetch.ts
      stubs.ts          # stubProvider, memoryCacheRepo
      fixtures.ts       # jsonResponse, sseResponse

vnext/apps/gateway/src/
  data-plane/
    routes.ts                     # rewritten in X-5
    providers/
      registry.ts                 # providerFactories dict
    routing/                      # existing binding-resolver, candidates
    observability/
      attempts/
        conversation-attempt.ts
        embeddings-attempt.ts
        images-attempt.ts
    embeddings/ images/ models/   # endpoint-direct paths
    orchestrator/server-tools/    # web-search, image-generation
    # adapters/                   ← DELETED in X-6
```

---

## 7. Test Strategy

**Preserve (38 files, ~91%):** all control-plane, repo, observability primitive (quota-math, latency-tracker, usage-tracker, client-detect), provider/interceptor, copilot-quota, repackage-error, and E2E tests. None of these depend on IR shape.

**Delete (4 files, ~9%):** `pipeline.test.ts`, `messages-out.test.ts`, `chat-out.test.ts`, `observability/dispatch-observability.test.ts`.

**Add:**
- Per pair (×6): request-mapping tests, event-mapping tests, cancellation-propagation test. Use **inline programmatic SSE fixtures**, not `.txt` replay files — fixtures stay readable inline, version with translator changes, and don't accumulate stale event vocabulary.
- Per attempt module (×3): success path, error path (upstream HTTPError), quota-rejection, streaming-tap behavior.
- Per route (×4 conversation + 1 embeddings + 1 images): end-to-end with stubbed `ModelProvider` via `providerFactories` swap. Use the existing `dispatch-quota.test.ts` shape (real `SqliteRepo`, `globalThis.fetch` stub, Hono auth-shim).
- Server-tools: update `server-tool-*.e2e` to assert observability now records.

**Forbidden patterns** (from prior incident — see auto-memory):
- `mock.module()` (Bun 1.3 leaks across test files). Use `globalThis.fetch` overrides + real repos instead.
- Hidden global state in test fixtures (each test owns its repo + fetch override).

---

## 8. Provider-Internal Layering

Within each provider package, separate three layers:

| Layer | Files | Responsibility |
|---|---|---|
| Transport | `transport/*.ts` | HTTP, auth headers, retry, error → HTTPError |
| Catalog | `catalog/*.ts` | model list, variants, capability/endpoint discovery |
| Parse | `parse/*.ts` | native SSE bytes → typed events; native body JSON → typed body |

`provider.ts` orchestrates the three. Translators are **outside** the provider — they consume the provider's typed events. This keeps provider packages free of hub knowledge: a provider could ship without ever knowing Messages exists.

---

## 9. Out of Scope (this spec)

- Multi-version hub protocol negotiation.
- New providers beyond copilot (the architecture admits them; we do not add one in this pivot).
- Tool-use semantics changes (round-trip stays at parity with current behavior).
- Performance optimizations (the rewrite targets architectural cleanliness; perf budget unchanged).
- Web-search / image-generation feature changes (handler internals unchanged; only attempt-module integration).

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Long branch divergence on `vNext` | Sub-stages keep tree green per stage; rebase frequently. |
| Hub protocol drift vs Anthropic upstream | `HUB_VERSION` constant + opaque pass-through for unknown fields + explicit hub-package ownership. |
| Lossy translation for less-aligned pairs (e.g. gemini↔messages) | Document parity matrix per pair; non-lossless cases are explicit (e.g. `redacted_thinking` drops on chat client). |
| Cancellation regressions | Mandatory cancellation test per pair; signal threading reviewed in spec-compliance review. |
| Test gaps after deleting 4 IR tests | X-9 adds pair + attempt + route tests before stage gate; coverage diff reviewed. |

---

## 11. Effort Estimate

From the survey:

| Stage | Files | LOC delta | Notes |
|---|---|---|---|
| X-1 hub protocol | +5 new | +400 | `messages/` types, freeze a version |
| X-2 ModelProvider iface | ±3 | ±50 | refactor `provider-copilot` w/o behavior change |
| X-3 pairwise translators | +18 (6 dirs ~3 files) | +1500 | with shared modules; ports logic from existing IR adapters |
| X-4 attempt modules | +3 | +250 | extract from `dispatch()` |
| X-5 routes rewrite | ±1 | -150 net | dispatch simplified |
| X-6 IR + adapter deletion | -10 | -1100 | clean removal |
| X-7 server-tools rewire | ±2 | ±50 | call attempt modules |
| X-8 test deletion | -4 | -300 | |
| X-9 test additions | +25 | +1500 | per-pair + per-attempt + e2e |
| **Net** | **~+30 / -15** | **~+2100** | rewrite-equivalent ~2-3 weeks single-engineer |

Total touched files: ~45. Total architectural LOC moved: ~2100.

---

## 12. Acceptance Criteria

The pivot is complete when:

1. `@vnext/protocols/ir` does not exist.
2. `routes.ts dispatch()` references no `IR*` types and no `FrontendAdapter`/`BackendAdapter`.
3. Every conversation route flows through: `client parse → pairwise translator → attempt module → ModelProvider.call*` (or messages-native fast path).
4. `ModelProvider` interface is implemented identically by `provider-copilot`; a stub second provider can be registered via `providerFactories` and routed to without gateway changes.
5. Web-search and image-generation handlers no longer log "observability bypass" — observability runs through attempt modules.
6. All 38 architecture-independent tests pass.
7. New per-pair / per-attempt / e2e tests pass.
8. A `cancellation propagates` test passes for each of the 6 translator pairs.
