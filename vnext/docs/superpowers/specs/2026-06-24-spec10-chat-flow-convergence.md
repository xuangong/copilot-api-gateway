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
- `select-binding` stays in gateway (LLM-binding concept).

## 3. Architecture

### 3.1 Hook surface (the kit's public contract)

The kit is **domain-neutral**: it knows nothing about LLM endpoints,
binding kinds, or protocol literals. It defines a `ServeTemplateHooks`
contract parameterised over endpoint-specific payload / attempt-result /
extra types. The gateway adapter supplies the literals.

```ts
// @vnext-gateway/chat-flow-kit/src/serve-template.ts

export interface KitAuthCtx {
  /** Optional per-key id used for quota lookup and telemetry tagging. */
  readonly apiKeyId?: string | null
  /** Allow endpoint adapters to round-trip their own auth payload through
   *  the kit without the kit reading it. */
  readonly [extra: string]: unknown
}

export interface KitObsCtx {
  readonly apiKeyId?: string | null
  readonly userAgent?: string | null
  readonly requestId?: string | null
  readonly [extra: string]: unknown
}

export interface ServeTemplateInput {
  readonly raw: unknown
  readonly auth: KitAuthCtx
  readonly obsCtx: KitObsCtx
  readonly signal?: AbortSignal
  /** Catch-all bag for endpoint-specific side inputs (gemini model/verb,
   *  responses requestId/userAgent passthrough). Opaque to the kit. */
  readonly extras: Record<string, unknown>
}

export interface PreProcessCtx {
  readonly auth: KitAuthCtx
}

/** preProcess returns one of two shapes: continue with a (possibly
 *  mutated) payload + extra, OR short-circuit with a Response. The
 *  short-circuit branch lets endpoints render bespoke error envelopes
 *  (e.g. responses' previous_response_not_found) without the kit
 *  knowing about their wire shape. */
export type PreProcessResult<TPayload, TExtra> =
  | { kind: 'continue'; payload: TPayload; extra: TExtra }
  | { kind: 'short-circuit'; response: Response; extra: TExtra }

export interface RunAttemptArgs<TPayload> {
  readonly payload: TPayload
  readonly auth: KitAuthCtx
  readonly telemetryCtx: TelemetryRequestContext
  readonly downstreamAbortSignal: AbortSignal
  readonly requestStartedAt: number
  readonly extras: Record<string, unknown>
}

export interface RespondCtx<TPayload, TExtra> {
  readonly payload: TPayload
  readonly extra: TExtra
  readonly wantsStream: boolean
  readonly downstreamAbortController: AbortController
  readonly telemetryCtx: TelemetryRequestContext
  readonly extras: Record<string, unknown>
}

export interface ServeTemplateHooks<TPayload, TAttemptResult, TExtra = undefined> {
  /** Caller-supplied tag for telemetry. The kit treats this as an opaque
   *  string and never branches on it — keeps the framework purity gate
   *  intact (no LLM literals inside the kit). */
  readonly endpointTag: string

  /**
   * Parse the raw HTTP body (and any caller-supplied side inputs like
   * gemini's URL-extracted model) into the endpoint's typed payload.
   * Throws on validation failure with `{ status, body }` shape; the kit
   * wraps that into `jsonErrorWrap`. Endpoints that need a bespoke 4xx
   * envelope (none today) can override via `parseErrorRender`.
   */
  parse(input: ServeTemplateInput): Promise<TPayload> | TPayload

  /** Optional renderer for parse() failures. Default: `jsonErrorWrap`. */
  parseErrorRender?(err: Error & { status?: number; body?: unknown }): Response

  /**
   * Endpoint-specific work between parse and quotaGate. Used by the
   * responses endpoint to expand `previous_response_id` against the
   * responses store; returns either `{kind:'continue', payload, extra}`
   * to proceed, or `{kind:'short-circuit', response, extra}` to render
   * an endpoint-specific error envelope (e.g.
   * `PreviousResponseNotFoundError` → OpenAI-verbatim 400 with `code`
   * + `param`). Default: no-op continue with `extra: undefined as TExtra`.
   */
  preProcess?(payload: TPayload, ctx: PreProcessCtx): Promise<PreProcessResult<TPayload, TExtra>>

  /**
   * Decide stream-vs-JSON. Most endpoints read `payload.stream === true`;
   * gemini reads its URL-derived `forceStream` from `input.extras`.
   */
  wantsStream(payload: TPayload, input: ServeTemplateInput): boolean

  /**
   * Invoke the endpoint's attempt orchestrator. The kit does not know
   * the attempt's shape — it just forwards what attempt needs and
   * receives back an opaque result.
   */
  runAttempt(args: RunAttemptArgs<TPayload>): Promise<TAttemptResult>

  /**
   * Serialise the attempt result into the HTTP Response. Receives the
   * parsed payload + extra so endpoints that derive per-response flags
   * from the payload (e.g. chat_completions' `include_usage` →
   * `includeUsageChunk`) can compute them here without the kit caring.
   */
  respond(result: TAttemptResult, ctx: RespondCtx<TPayload, TExtra>): Promise<Response>
}

export interface ServeTemplateResult<TExtra> {
  readonly response: Response
  readonly extra: TExtra | undefined
}

export async function serveTemplate<TPayload, TAttemptResult, TExtra = undefined>(
  hooks: ServeTemplateHooks<TPayload, TAttemptResult, TExtra>,
  input: ServeTemplateInput,
  deps: ServeTemplateDeps,
): Promise<ServeTemplateResult<TExtra>> { … }
```

### 3.2 Injected dependencies (the kit's required collaborators)

To stay domain-neutral the kit takes its env-touching collaborators by
injection instead of importing them. The gateway adapter constructs a
singleton `ServeTemplateDeps` once and reuses it.

```ts
export interface ServeTemplateDeps {
  /** Daily per-key quota check. Returns a 429 Response when over cap,
   *  null when allowed. Implemented by gateway (currently
   *  `runQuotaGate` in chat-flow/shared/quota-gate.ts) and injected
   *  here so the kit does not import gateway state. */
  readonly runQuotaGate: (apiKeyId: string | null | undefined) => Promise<Response | null>

  /** Wraps `{status, body}` into a JSON Response with content-type set.
   *  Used for parse/preProcess error rendering. Implemented by gateway
   *  (currently `jsonErrorWrap` in chat-flow/shared/error-wrap.ts). */
  readonly jsonErrorWrap: (status: number, body: unknown) => Response

  /** Constructs the per-request telemetry context. The kit hands the
   *  raw obsCtx + auth + flags through; the implementation fills in
   *  runtimeLocation and any other gateway-known fields. */
  readonly buildTelemetryCtx: (input: {
    auth: KitAuthCtx
    obsCtx: KitObsCtx
    isStreaming: boolean
    requestStartedAt: number
  }) => TelemetryRequestContext
}
```

`TelemetryRequestContext` is a plain interface and stays where it
already lives (`@vnext-llm/gateway`'s `chat-flow/shared/telemetry-ctx.ts`)
for Spec 10. Promoting it to a framework package is a clean follow-up
that doesn't block this spec; the kit imports the type via a
side-effect-free type-only import path that we'll set up during
implementation (likely a tiny `@vnext-gateway/observability-types`
package, or a re-export from `@vnext-gateway/service`). Whichever
choice we land on, the runtime code in the kit never depends on the
gateway business package.

### 3.3 Fixed skeleton (what `serveTemplate` does)

1. `try { payload = await hooks.parse(input) } catch (e) → hooks.parseErrorRender?.(e) ?? deps.jsonErrorWrap(...)`.
2. If `hooks.preProcess` is provided: run it, branch on the result:
   - `'short-circuit'` → return `{ response, extra }` immediately
     (skipping quota gate, attempt, respond).
   - `'continue'` → adopt the returned `payload` + `extra`.
   - Throws from preProcess → fall back to `deps.jsonErrorWrap` using
     the same `{status, body}` shape contract as parse.
3. `wantsStream = hooks.wantsStream(payload, input)`.
4. `telemetryCtx = deps.buildTelemetryCtx({ auth, obsCtx, isStreaming: wantsStream, requestStartedAt })`.
5. `const quotaResp = await deps.runQuotaGate(input.auth.apiKeyId); if (quotaResp) return { response: quotaResp, extra }`.
6. Create linked `AbortController` (mirror current serves).
7. `const result = await hooks.runAttempt({ payload, auth, telemetryCtx, downstreamAbortSignal: controller.signal, requestStartedAt, extras: input.extras })`.
8. `const response = await hooks.respond(result, { payload, extra, wantsStream, downstreamAbortController: controller, telemetryCtx, extras: input.extras })`.
9. `return { response, extra }`.

### 3.4 Per-endpoint adapter shape

Each endpoint's new `serve.ts` shrinks to a hook declaration + a single
`serveTemplate(...)` call. Example for chat-completions:

```ts
// chat-completions/serve.ts (after)
const chatCompletionsHooks: ServeTemplateHooks<ChatCompletionsPayload, ChatCompletionsAttemptResult> = {
  endpointTag: 'chat_completions',
  parse: ({ raw }) => parseChatCompletionsPayload(raw) as ChatCompletionsPayload,
  wantsStream: (p) => p.stream === true,
  runAttempt: async (a) => chatCompletionsAttempt.generate({
    payload: a.payload, auth: a.auth as ChatCompletionsAttemptAuth,
    ctx: { downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
  }),
  // respond receives payload, so includeUsageChunk derives here —
  // respondChatCompletions stays unchanged.
  respond: async (r, c) => respondChatCompletions(r, {
    wantsStream: c.wantsStream,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
    includeUsageChunk: c.payload.stream_options?.include_usage === true,
  }),
}

export async function serveChatCompletions(args: ChatCompletionsServeArgs): Promise<Response> {
  const { response } = await serveTemplate(chatCompletionsHooks, {
    raw: args.raw, auth: args.auth, obsCtx: args.obsCtx, signal: args.signal,
    extras: {},
  }, kitDeps)
  return response
}
```

Notes:
- `responses` declares `preProcess` to run `expandPreviousResponseId`
  and capture `mergedInputItems` as `extra`. On
  `PreviousResponseNotFoundError` it returns
  `{kind:'short-circuit', response: renderPreviousResponseNotFound(err), extra: { mergedInputItems: [] }}`
  so the OpenAI-verbatim `code: 'previous_response_not_found'` envelope
  (with `param`) is preserved. `serveResponses` returns
  `ServeTemplateResult<{ mergedInputItems: unknown[] }>` so
  `responses/http.ts` keeps the same external shape.
- `gemini` puts `{ model, forceStream }` into `input.extras`; its
  `wantsStream` reads `input.extras.forceStream as boolean`;
  `runAttempt` forwards both to `geminiAttempt.generate`.
- `messages` is the simplest case — no preProcess, no extras, payload
  stream flag, plain respondMessages call.

## 4. Package boundary & dependency direction

`@vnext-gateway/chat-flow-kit` MUST sit at the framework layer next to
`@vnext-gateway/upstream` and `@vnext-gateway/service`. To stay
domain-neutral, the kit **must not** depend on `@vnext-llm/gateway` (the
LLM business package) and **must not** import any LLM type or literal.

**Dependency direction (one-way only):**
```
@vnext-llm/gateway  →  @vnext-gateway/chat-flow-kit  →  @vnext-gateway/{service, platform, observability-types?}
```

No back-edges. `runQuotaGate` and `jsonErrorWrap` stay in
`@vnext-llm/gateway` and are **injected** into the kit via
`ServeTemplateDeps` (see §3.2) — the kit only declares their signatures.

## 5. Acceptance

A1. `bun test` — all chat-flow tests still pass without modification
   (no behaviour change; only call-site refactor).
A2. `bun --filter '@vnext-gateway/chat-flow-kit' run typecheck` and
   `bun --filter '@vnext-llm/gateway' run typecheck` both pass. (The
   business gateway package is `@vnext-llm/gateway`, not
   `@vnext-gateway/gateway`.)
A3. Framework purity gate for `@vnext-gateway/chat-flow-kit/src/**`:
   - zero imports from any `@vnext-llm/*` package;
   - zero string literals containing `chat_completions`, `messages`,
     `responses`, `gemini`, `Copilot`, `Anthropic`, or `OpenAI`
     (including the `endpointTag` — it's caller-supplied; the kit must
     never compare against these strings);
   - manual `rg` to confirm both rules.
A4. Each endpoint's `serve.ts` shrinks to < 60 lines (current floor:
   chat-completions ~115, messages ~120, responses ~178, gemini ~128).
A5. Kit-level unit suite covers: skeleton order (parse → preProcess →
   quotaGate → attempt → respond), parse error path (with and without
   `parseErrorRender`), preProcess short-circuit (no quota call, no
   attempt), preProcess continue + payload mutation, quota gate
   short-circuit (no attempt invoked), AbortController linking
   (downstream signal abort propagates), and respond receiving the
   final payload + extra.
A6. Docker `--no-cache` build of `apps/platform-bun` succeeds (new
   package wired into `Dockerfile` COPY list).
A7. Live smoke (deferred to deploy window): /v1/chat/completions
   stream + /v1/messages stream + /v1/responses with
   `previous_response_id` (success + miss → OpenAI-verbatim 400) +
   `/v1beta/models/<m>:streamGenerateContent` each return the same
   wire frames as pre-Spec-10.

## 6. Out-of-scope follow-ups

- **Spec 11 (optional):** dedupe attempt.ts skeletons (selectBinding
  switch + terminal). Defer until Spec 10 lands; the attempt black-box
  contract here gives Spec 11 room to either swap attempts wholesale
  or hollow them out further.
- Promoting `TelemetryRequestContext` and `checkQuota` into a proper
  framework package (e.g. `@vnext-gateway/observability`). Spec 10
  routes around this with type-only imports + DI; the proper promotion
  is a follow-up once we have a second consumer.
