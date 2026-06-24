# Spec 10 — chat-flow convergence (serve template → framework kit)

> vNext Roadmap §3 step 5. After this spec, vNext reaches the
> "framework can serve any vertical" boundary.

## 1. Problem

`vnext/packages/gateway/src/data-plane/chat-flow/` has 4 LLM endpoint
pipelines (chat-completions / messages / responses / gemini). Each one
owns its own `serve.ts`, `attempt.ts`, `respond.ts`. The three serves are
~90% identical (parse → telemetry ctx → quota gate → linked
AbortController → attempt → respond) and the four attempts share the same
skeleton (selectBinding → kind switch → terminal that calls
`provider.fetch`).

Roadmap §3 step 5 asks us to collapse the serve template into a
framework-level kit so adding a new endpoint (or, eventually, a new
vertical like embeddings/images) only requires declaring the
protocol-specific pieces.

## 2. Scope

**In:**
- New framework package `@vnext-gateway/chat-flow-kit` with a single
  `serveTemplate(...)` entry point.
- Migrate all 4 endpoint serves (`chat_completions`, `messages`,
  `responses`, `gemini`) to declare their endpoint-specific hooks and
  call `serveTemplate`.
- Keep all four `respond.ts` files unchanged (B-scope decision: SSE/JSON
  serialisation stays per-endpoint because it is the protocol's wire
  shape, not framework concern).
- Keep all four `attempt.ts` files unchanged (black-box decision: the
  kit is domain-neutral and treats the attempt as a caller-supplied
  callback; deduping attempt skeletons is a possible Spec 11, not in
  scope here).

**Out of scope:**
- `count-tokens`, gemini `state-bridge` / `reshape-count` /
  `count-tokens.ts` / `http.ts` — these are endpoint-specific helpers
  that don't fit the serve template.
- Cross-protocol dispatch (already lives inside attempt via
  `traverseTranslation`; kit doesn't see it).
- `shared/select-binding`, `shared/quota-gate`,
  `shared/telemetry-ctx`, `shared/error-wrap`: stay in gateway. The kit
  imports `quota-gate`, `telemetry-ctx`, and `error-wrap` from gateway
  shared until Spec 11 (or later) decides whether to promote them.
  **For Spec 10, that means the kit depends on `@vnext-gateway/gateway`
  for these helpers, OR we copy minimal shims into the kit.** See §4 for
  the resolution.

## 3. Architecture

### 3.1 Hook surface (the kit's public contract)

```ts
// @vnext-gateway/chat-flow-kit/src/serve-template.ts

import type { DataPlaneAuthCtx } from '...'  // gateway type, see §4
import type { TelemetryRequestContext } from '...'

export interface ServeTemplateHooks<TPayload, TAttemptResult, TExtra = void> {
  /** Endpoint key for telemetry tagging. */
  readonly endpointKey: 'chat_completions' | 'messages' | 'responses' | 'gemini'

  /**
   * Parse the raw HTTP body (and any caller-supplied side inputs like
   * gemini's URL-extracted model) into the endpoint's typed payload.
   * Throws on validation failure with `{ status, body }` shape; the kit
   * wraps that into `jsonErrorWrap`.
   */
  parse(input: ServeTemplateInput): Promise<TPayload> | TPayload

  /**
   * Endpoint-specific work between parse and quotaGate. Used by the
   * responses endpoint to expand `previous_response_id` against the
   * responses store and capture `mergedInputItems`. Default: no-op.
   * Returns the (possibly mutated) payload plus an opaque `extra`
   * value that flows through to the final result envelope.
   */
  preProcess?(payload: TPayload, ctx: PreProcessCtx): Promise<{
    payload: TPayload
    extra: TExtra
  }>

  /**
   * Decide stream-vs-JSON. Most endpoints read `payload.stream === true`;
   * gemini reads its URL-derived `forceStream` flag instead.
   */
  wantsStream(payload: TPayload, input: ServeTemplateInput): boolean

  /**
   * Invoke the endpoint's attempt orchestrator. The kit does not know
   * the attempt's shape — it just forwards what attempt needs and
   * receives back an opaque result.
   */
  runAttempt(args: RunAttemptArgs<TPayload>): Promise<TAttemptResult>

  /**
   * Serialise the attempt result into the HTTP Response. The kit hands
   * the result back along with the same telemetry ctx + linked
   * controller so respond.ts can wire SSE cancellation correctly.
   */
  respond(result: TAttemptResult, ctx: RespondCtx): Promise<Response>
}

export interface ServeTemplateInput {
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  readonly signal?: AbortSignal
  /** Catch-all bag for endpoint-specific side inputs (gemini model/verb,
   *  responses requestId/userAgent passthrough). */
  readonly extras: Record<string, unknown>
}

export interface PreProcessCtx {
  readonly auth: DataPlaneAuthCtx
}

export interface RunAttemptArgs<TPayload> {
  readonly payload: TPayload
  readonly auth: DataPlaneAuthCtx
  readonly telemetryCtx: TelemetryRequestContext
  readonly downstreamAbortSignal: AbortSignal
  readonly requestStartedAt: number
  readonly extras: Record<string, unknown>
}

export interface RespondCtx {
  readonly wantsStream: boolean
  readonly downstreamAbortController: AbortController
  readonly telemetryCtx: TelemetryRequestContext
}

export interface ServeTemplateResult<TExtra> {
  readonly response: Response
  readonly extra: TExtra
}

export async function serveTemplate<TPayload, TAttemptResult, TExtra = void>(
  hooks: ServeTemplateHooks<TPayload, TAttemptResult, TExtra>,
  input: ServeTemplateInput,
): Promise<ServeTemplateResult<TExtra>> { … }
```

### 3.2 Fixed skeleton (what `serveTemplate` does)

1. `try { payload = await hooks.parse(input) } catch (e) → jsonErrorWrap`.
2. `let extra: TExtra = undefined as TExtra` then if
   `hooks.preProcess`, run it (same try/catch → `jsonErrorWrap`).
3. `wantsStream = hooks.wantsStream(payload, input)`.
4. Build `TelemetryRequestContext` (apiKeyId / userAgent / requestId /
   isStreaming / runtimeLocation / requestStartedAt).
5. `const quotaResp = await runQuotaGate(input.auth.apiKeyId); if (quotaResp) return { response: quotaResp, extra }`.
6. Create linked `AbortController` (mirror current serves).
7. `const result = await hooks.runAttempt({ payload, auth, telemetryCtx, downstreamAbortSignal: controller.signal, requestStartedAt, extras: input.extras })`.
8. `const response = await hooks.respond(result, { wantsStream, downstreamAbortController: controller, telemetryCtx })`.
9. `return { response, extra }`.

### 3.3 Per-endpoint adapter shape

Each endpoint's new `serve.ts` shrinks to a hook declaration + a single
`serveTemplate(...)` call. Example for chat-completions:

```ts
// chat-completions/serve.ts (after)
export async function serveChatCompletions(args: ChatCompletionsServeArgs): Promise<Response> {
  const { response } = await serveTemplate(chatCompletionsHooks, {
    raw: args.raw, auth: args.auth, obsCtx: args.obsCtx, signal: args.signal,
    extras: {},
  })
  return response
}

const chatCompletionsHooks: ServeTemplateHooks<ChatCompletionsPayload, ChatCompletionsAttemptResult> = {
  endpointKey: 'chat_completions',
  parse: ({ raw }) => parseChatCompletionsPayload(raw),
  wantsStream: (p) => p.stream === true,
  runAttempt: async (a) => chatCompletionsAttempt.generate({
    payload: a.payload, auth: a.auth, ctx: { downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
  }),
  respond: async (r, c) => respondChatCompletions(r, {
    wantsStream: c.wantsStream, downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx, includeUsageChunk: /* derived in parse-result or extras */,
  }),
}
```

Notes:
- `responses` declares `preProcess` to run `expandPreviousResponseId` and
  populates `extra: { mergedInputItems }`. `serveResponses` returns
  `ServeTemplateResult<{ mergedInputItems: unknown[] }>` so http.ts keeps
  the same external shape.
- `gemini` puts `{ model, forceStream }` into `input.extras`; its
  `wantsStream` reads `input.extras.forceStream`; `runAttempt` forwards
  both to `geminiAttempt.generate`.
- `chat_completions` derives `includeUsageChunk` either inside `parse`
  (return a wrapped payload) or by computing it inside `respond` from
  the raw payload — TBD during implementation; whichever keeps the hook
  surface narrower.

## 4. Package boundary & dependency direction

`@vnext-gateway/chat-flow-kit` MUST sit at the framework layer next to
`@vnext-gateway/upstream` and `@vnext-gateway/service`. To stay
domain-neutral, the kit cannot depend on `@vnext-gateway/gateway` (which
imports LLM types). Three things the kit needs from current gateway
shared code:

1. `TelemetryRequestContext` shape and constructor inputs
   (`getRuntimeLocation`, `apiKeyId`, `requestId`, etc).
2. `runQuotaGate(apiKeyId): Promise<Response | null>`.
3. `jsonErrorWrap(status, body): Response`.

**Resolution:**
- `TelemetryRequestContext` is already a plain interface — promote it
  to `@vnext-gateway/service` (or a new `@vnext-gateway/observability`
  micro-package if service feels too narrow). `getRuntimeLocation`
  already lives in `@vnext-gateway/platform`.
- `runQuotaGate` and `jsonErrorWrap` move into the kit as **kit-level
  primitives** because they are domain-neutral (HTTP envelope helpers
  and per-key quota enforcement). Gateway re-exports them for any
  remaining consumers (count-tokens, gemini's state-bridge) so call
  sites don't churn.
- `DataPlaneAuthCtx` and `DispatchObsCtx` are LLM-business types — the
  kit declares its own minimal `KitAuthCtx` / `KitObsCtx` interfaces
  with the fields it actually reads (`apiKeyId`, `userAgent`,
  `requestId`, plus a pass-through `unknown` for the rest), and the
  endpoint adapters do a structural pass-through cast at the call
  site. No business types leak into the framework package.

This keeps the dependency direction one-way:
`gateway → chat-flow-kit → service/platform`. No back-edges.

## 5. Acceptance

A1. `bun test` — all chat-flow tests still pass without modification
   (no behaviour change; only call-site refactor).
A2. `bun --filter '@vnext-gateway/chat-flow-kit' run typecheck` and
   `bun --filter '@vnext-gateway/gateway' run typecheck` both pass.
A3. Framework purity gate: `chat-flow-kit/src/**` has zero references
   to `@vnext-llm/*`, `chat_completions`, `messages`, `responses`,
   `gemini`, `Copilot`, `Anthropic`, `OpenAI`. Manual `rg` to confirm.
A4. Each endpoint's `serve.ts` shrinks to < 60 lines (current floor:
   chat-completions ~115, messages ~120, responses ~178, gemini ~128).
A5. Docker `--no-cache` build of `apps/platform-bun` succeeds (new
   package wired into `Dockerfile` COPY list).
A6. Live smoke (deferred to deploy window): /v1/chat/completions
   stream + /v1/messages stream + /v1/responses with
   `previous_response_id` + `/v1beta/models/<m>:streamGenerateContent`
   each return the same wire frames as pre-Spec-10.

## 6. Out-of-scope follow-ups

- **Spec 11 (optional):** dedupe attempt.ts skeletons (selectBinding
  switch + terminal). Defer until Spec 10 lands; the attempt black-box
  contract here gives Spec 11 room to either swap attempts wholesale
  or hollow them out further.
- Promoting `select-binding` to the kit would force the kit to know
  LLM-binding concepts — explicitly rejected here.
