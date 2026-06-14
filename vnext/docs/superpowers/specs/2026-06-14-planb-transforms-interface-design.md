# Plan B — Transforms 下放 + ModelProvider 接口收紧

**Date**: 2026-06-14
**Status**: Approved (design)
**Scope**: vNext gateway internal refactor — no wire-level changes
**Predecessor**: Plan A (physical restructuring) ✅ landed

---

## Goal

Make `provider-copilot` the single owner of all Copilot-specific request/response transforms, and tighten `ModelProvider` so the only data-plane entry point is `fetch(req: ProviderRequest)`.

After Plan B:
- `packages/gateway` contains zero Copilot-aware code.
- New providers don't need to know transforms exist.
- The `call*` zoo (7 dead optional methods) is gone.
- `routes.ts:351` no longer special-cases `count_tokens` with a direct pipeline call.

This is an **internal** refactor. HTTP contracts, route paths, request/response bodies, and SDK behavior do not change. The 754 pass / 4 pre-existing-fail test baseline must hold.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ gateway/data-plane/routes.ts                                │
│   • zod-validate inbound request                            │
│   • build ProviderRequest                                   │
│   • call binding.provider.fetch(req)  ← only entry point    │
│   • imports zero transforms                                 │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ provider-copilot/src/provider.ts                            │
│   fetch(req): Promise<ProviderResponse>                     │
│     1. interceptorsFor(req.endpoint) → chain                │
│     2. runInterceptors(invocation, ctx, chain, terminal)    │
│     3. terminal: real upstream HTTP                         │
└─────────────────────────────────────────────────────────────┘
```

The Koa-style `runInterceptors` runtime already exists in `@vnext/interceptor`, and `provider-copilot` already calls it from `fetch()`. Plan B finishes the consolidation that A1/A2/A3 set up.

---

## B1 — Transforms 合并

### Current state

- `packages/gateway/src/data-plane/transforms/`: 32 transforms + `index.ts` + `pipeline.ts` + `types.ts`. Three exported pipelines (`runAnthropicMessagesPipeline`, `runAnthropicCountTokensPipeline`, `runResponsesChatFallbackPipeline`).
- `packages/provider-copilot/src/transforms/`: 14 transforms (a strict subset).
- `packages/provider-copilot/src/interceptors/`: `chat-completions/`, `embeddings/`, `messages/`, `responses/`, `shared/` — already wired into `provider.fetch()` via `runInterceptors`.

### Target

Move all 18 transforms unique to gateway into `provider-copilot/src/transforms/`, wrap each in (or extend an existing) interceptor under the matching endpoint directory, then **delete `packages/gateway/src/data-plane/transforms/` entirely**.

### Migration map

Gateway dir has 32 entries; 14 overlap with provider-copilot, 3 are non-transform scaffolding (`index.ts`, `types.ts`, `pipeline.ts`). That leaves 15 net-new transform files + the 3 pipelines dissolved into interceptor chain order. The table below lists every distinct migration step.

| Transform (gateway) | Endpoint(s) | Target interceptor file |
|---|---|---|
| `apply-top-level-cache-control.ts` | messages | `interceptors/messages/apply-top-level-cache-control.ts` |
| `billing-header.ts` | shared | `interceptors/shared/billing-header.ts` |
| `cache-control.ts` | messages, chat-completions | `interceptors/shared/cache-control.ts` |
| `chat-whitespace-abort.ts` | chat-completions | `interceptors/chat-completions/whitespace-abort.ts` |
| `compact-responses-input.ts` | responses | `interceptors/responses/compact-input.ts` |
| `context-management.ts` | messages | `interceptors/messages/context-management.ts` |
| `disable-reasoning-on-forced-tool-choice.ts` | chat-completions, responses | `interceptors/shared/disable-reasoning-on-forced-tool-choice.ts` |
| `pipeline.ts` (runAnthropicMessagesPipeline) | messages | dissolved into `interceptors/messages/index.ts` chain order |
| `pipeline.ts` (runAnthropicCountTokensPipeline) | messages_count_tokens | new `interceptors/messages-count-tokens/index.ts` |
| `pipeline.ts` (runResponsesChatFallbackPipeline) | responses | dissolved into `interceptors/responses/index.ts` chain order |
| `promote-thinking-display.ts` | messages, responses | `interceptors/shared/promote-thinking-display.ts` |
| `responses-sse-interceptor.ts` | responses | `interceptors/responses/sse-stream.ts` (post-stream hook) |
| `rewrite-context-window-error.ts` | shared (response side) | `interceptors/shared/rewrite-context-window-error.ts` |
| `service-tier-strip.ts` | chat-completions | `interceptors/chat-completions/service-tier-strip.ts` |
| `streaming-id-fix.ts` | responses | `interceptors/responses/streaming-id-fix.ts` |
| `strip-tool-strict.ts` | chat-completions, responses | `interceptors/shared/strip-tool-strict.ts` |
| `thinking-cleanup.ts` | messages, responses | `interceptors/shared/thinking-cleanup.ts` |
| `tool-type.ts` | chat-completions, responses | `interceptors/shared/tool-type.ts` |
| `whitespace-guard.ts` | messages | `interceptors/messages/whitespace-guard.ts` |

> The exact endpoint binding for each transform must mirror its current `pipeline.ts` placement. The implementer reads `pipeline.ts` as ground truth for ordering.

### Order preservation

The three current pipelines run transforms imperatively in a fixed order. The new interceptor chains must produce **bit-identical** payloads/headers for each endpoint. The implementer:

1. Reads `pipeline.ts` to recover the exact sequence per endpoint.
2. Writes the matching `interceptors/<endpoint>/index.ts` chain in the same sequence.
3. Verifies through routes-level tests (no transforms unit tests exist).

### count_tokens cleanup

`packages/gateway/src/data-plane/routes.ts:351` currently does:

```ts
const transformed = runAnthropicCountTokensPipeline(payload)
const upstreamResponse = await binding.provider.fetch('messages_count_tokens', {
  ...init,
  body: JSON.stringify(transformed),
})
```

After B1:

```ts
const upstreamResponse = await binding.provider.fetch({
  endpoint: 'messages_count_tokens',
  payload,
  headers: c.req.raw.headers,
  sourceApi: 'anthropic',
  signal: c.req.raw.signal,
  flags: { isStreaming: false },
})
```

The `import { runAnthropicCountTokensPipeline } from './transforms'` line is removed. `routes.ts` no longer references any transforms module.

### Sidecar snapshot (responses endpoint)

The non-stream snapshot writer (commit 33a16c9, `defer non-stream snapshot save to waitUntil`) currently lives inline in routes.ts. It moves into a responses post-stream interceptor:

- Hook fires after the upstream response body is consumed.
- Uses `ctx.waitUntil(...)` exactly as today (does not block the HTTP response).
- Keeps the round-trip snapshot-id behavior locked by test 69d489c.

### Deletion

After B1:
- `packages/gateway/src/data-plane/transforms/` deleted in full.
- `packages/gateway/package.json` no longer needs related internal exports.
- No remaining import of transforms from anywhere in `packages/gateway/`.

---

## B2 — ModelProvider 接口收紧

### Interface diff (`packages/provider/src/types.ts`)

**Before** (current, 166 lines):

```ts
export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
  getPricingForModelKey(modelKey: string): ModelPricing | null

  callMessages?(...): Promise<...>
  callMessagesCountTokens?(...): Promise<...>
  callChatCompletions?(...): Promise<...>
  callResponses?(...): Promise<...>
  callEmbeddings?(...): Promise<...>
  callImagesGenerations?(...): Promise<...>
  callGemini?(...): Promise<...>
}
```

**After**:

```ts
export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  fetch(req: ProviderRequest): Promise<ProviderResponse>
  getPricingForModelKey(modelKey: string): ModelPricing | null
}
```

The 7 optional `call*` methods are deleted (zero call sites — confirmed via grep). The `fetch` signature collapses to a single typed object.

### New types

```ts
export type SourceApi = 'anthropic' | 'openai' | 'gemini'

export interface ProviderRequestFlags {
  isStreaming: boolean
  hasWebSearch?: boolean
  hasImageGen?: boolean
}

export interface ProviderRequest {
  endpoint: EndpointKey
  payload: unknown               // schema-validated JSON object (NOT string)
  headers: Headers               // mutable across the interceptor chain
  sourceApi: SourceApi
  flags?: ProviderRequestFlags
  signal?: AbortSignal
}

export interface ProviderResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}
```

Rationale:
- `payload` as object (not stringified body) lets interceptors mutate fields without per-step `JSON.parse / stringify`.
- `flags` replaces the duck-typed `ProviderFetchOptions` opts bag with a closed set of known hints.
- `headers: Headers` instance is mutable along the chain; terminal HTTP reads the final state.
- `signal` is a top-level field, not buried inside `RequestInit`.

### Provider implementation impact

| Provider | Impact |
|---|---|
| `provider-copilot` | Destructure `req` at `fetch()` entry; existing `runInterceptors` wiring unchanged; terminal step does the single `JSON.stringify(invocation.payload)`. |
| `provider-azure` | Wrap into a `Request` once: `new Request(url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.payload), signal: req.signal })`. |
| `provider-custom` | Same shape as azure. |
| `provider-sdf` | Same shape as azure. |

### routes.ts dispatch shape

```ts
const providerResponse = await binding.provider.fetch({
  endpoint,
  payload: parsed.data,
  headers: c.req.raw.headers,
  sourceApi,
  flags: {
    isStreaming: parsed.data.stream === true,
    hasWebSearch: detectWebSearch(parsed.data),
    hasImageGen: detectImageGen(parsed.data),
  },
  signal: c.req.raw.signal,
})

return new Response(providerResponse.body, {
  status: providerResponse.status,
  headers: providerResponse.headers,
})
```

All 5 endpoint handlers (messages, messages/count_tokens, chat/completions, responses, gemini) share this shape via the existing `dispatch<TPayload>` generic.

### Backward compatibility

- Internal API only — no HTTP-level change.
- Test baseline (754 pass / 4 fail) must hold.
- SDK integration suites unchanged at the wire level → no regression risk.

---

## Data Flow (single request)

```
HTTP request
   │
   ▼
routes.ts: zod validate → ProviderRequest
   │
   ▼
provider.fetch(req)  ← provider-copilot
   │
   ▼
interceptorsFor(endpoint) → chain[]
   │
   ▼
runInterceptors(invocation, ctx, chain, terminal):
   transform A → next() →
     transform B → next() →
       ... →
         terminal()
   │
   ▼
terminal: real HTTP to api.githubcopilot.com
   body = JSON.stringify(invocation.payload)
   headers = invocation.headers (mutated by chain)
   signal = req.signal
   │
   ▼
Wrap upstream Response into ProviderResponse
   │
   ▼ (responses endpoint only)
post-stream interceptor schedules ctx.waitUntil(snapshot writer)
   │
   ▼
routes.ts: new Response(providerResponse.body, { status, headers })
   │
   ▼
HTTP response
```

count_tokens follows the same path with a shorter chain and no streaming.

---

## Error Handling

| Layer | Source | Behavior |
|---|---|---|
| routes.ts | zod validation fail | 400 with source-API-shaped error body (unchanged) |
| provider.fetch entry | endpoint not in `supportedEndpoints` | throw `UnsupportedEndpointError` → routes maps to 4xx |
| interceptor chain | interceptor throws | bubbles through `runInterceptors` → routes top-level catch |
| terminal HTTP | upstream 4xx/5xx | status passed through in `ProviderResponse` (no throw) |
| terminal HTTP | network / abort | throw `HTTPError` / `AbortError` → routes maps to 502/499 |

Constraints:
- Interceptors are pure transforms. They do not catch upstream HTTP errors and rewrap them; status pass-through stays at the terminal.
- routes.ts top-level `try/catch` keeps existing source-API error shaping behavior.
- Sidecar writer wraps its work in `try/catch + log` inside the `waitUntil` callback; never blocks the HTTP response (preserves commit 33a16c9 behavior).

---

## Testing

### Baseline

`bun test` from `vnext/`: 754 pass / 4 pre-existing fail. Plan B must hold this exactly.

### No transforms unit tests exist

Confirmed: `grep -r "transforms" tests/ -l` returns empty. All coverage is routes-level blackbox.

### Critical regression suites (priority order)

| Suite | Coverage | Why critical |
|---|---|---|
| `tests/api-resources/messages*.test.ts` | /v1/messages full chain | Most of the 18 migrated transforms run here |
| `tests/api-resources/messages-count-tokens*.test.ts` | /v1/messages/count_tokens | Verifies the routes.ts:351 cleanup |
| `tests/api-resources/chat-completions*.test.ts` | /v1/chat/completions | OpenAI shape transforms |
| `tests/api-resources/responses*.test.ts` | /v1/responses + sidecar snapshot | Sidecar writer relocates from routes to interceptor; commit 33a16c9 + 69d489c semantics must hold |
| SDK integration (`bun run local` then `test:integration:*`) | wire-level cross-SDK | Catches any silent drift |

### New tests

YAGNI — do not add new tests proactively. Only if migration uncovers a baseline gap, add 1–2 routes-level cases.

### Acceptance commands

```bash
cd vnext
bun test                # expect 754 pass / 4 fail (baseline)
bun run local &          # for integration
bun run test:integration:anthropic
bun run test:integration:openai
```

All four must pass before Plan B is considered complete.

---

## Risks

1. **Interceptor ordering drift** — the migration must reproduce `pipeline.ts` order exactly. Mitigation: implementer uses `pipeline.ts` as the ordering source-of-truth; routes-level tests fail loudly on payload drift.
2. **Sidecar timing** — moving the snapshot writer must keep it inside `ctx.waitUntil`, not inline. Mitigation: dedicated routes-level test (snapshot id round-trip, commit 69d489c) must remain green.
3. **Header mutation visibility at terminal** — interceptors mutate `invocation.headers`; terminal must read the final value. Already today's behavior in provider-copilot; verify no regression.
4. **Signal plumbing** — top-level `req.signal` must reach the terminal `fetch` call across all four providers. Mitigation: simple grep audit + an abort test if missing.

---

## Sequencing

Two serial phases:

1. **B1 — transforms 合并**: migrate 18 transforms, wire interceptors, delete gateway transforms directory, fix `routes.ts:351`. Run baseline + integration tests.
2. **B2 — interface 收紧**: introduce `ProviderRequest` / `ProviderResponse`, delete 7 `call*`, redesign `fetch` signature, adapt all four providers and `routes.ts` dispatch. Run baseline + integration tests.

Each phase commits independently. Plan C (factory table + routes split) starts only after B is fully landed.

---

## Out of Scope

- Plan C (provider factory table, routes.ts split into `data-plane/endpoints/{messages,chat-completions,responses,gemini}/`) — separate spec.
- Adding new transforms / interceptors beyond the 18 migrations.
- Wire-level (HTTP) contract changes.
- Provider-copilot internal interceptor file reorganization beyond what migration demands.
- Performance work.
