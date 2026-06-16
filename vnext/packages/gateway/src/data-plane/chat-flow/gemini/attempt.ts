// vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts
/**
 * Gemini generateContent attempt orchestrator.
 *
 * Mirrors `messages/attempt.ts` and `responses/attempt.ts` (Spec 3 Part 3) but
 * specialised for the Gemini source. Key structural differences:
 *
 *   - Gemini has NO identity target. Per `pair-selector.ts`, the gemini source
 *     PREFERENCE list is `messages → responses → chat_completions` — the
 *     gateway never serves a gemini-shaped hub endpoint. Every binding
 *     selection therefore picks a hub target and we always need a translator
 *     (one of PAIR_GEMINI_TO_MESSAGES, PAIR_GEMINI_TO_RESPONSES, PAIR_GEMINI_TO_CHAT).
 *
 *   - Because there's no identity case, there is no cross-protocol
 *     `dispatchFallback` either. All three targets are "cross-protocol from
 *     the client's POV"; the translator handles request + event reshaping in
 *     a single hop.
 *
 *   - Upstream stream is parsed in the HUB wire shape (one of
 *     `parseMessagesStream` / `parseChatCompletionsStream` / `parseResponsesStream`)
 *     so `withUpstreamTelemetry({protocol: <hub>})` reuses the hub's
 *     terminal-frame classifier + usage extractor. After telemetry
 *     decoration, we unwrap `ProtocolFrame<HubEvent>` back to bare hub events
 *     and feed them through `translator.translateEvents(events, {model})` to
 *     produce the bare `GeminiStreamEvent` sequence the client (and
 *     `gemini/respond.ts`) consumes. The output `EventResult` is therefore
 *     `EventResult<unknown>` carrying bare gemini events — NOT
 *     `ProtocolFrame<GeminiStreamEvent>` — because no gemini-shape protocol
 *     frame parser exists and the SSE writer (`encodeClientSSE('gemini', …)`)
 *     reads bare events.
 *
 *   - `forceStream` semantics (set by `gemini/serve.ts` when the verb is
 *     `streamGenerateContent`) are intentionally NOT consumed here. Whether
 *     to render SSE vs JSON is a presentation concern owned by `respond.ts`
 *     (per plan Part 4 Task 2 note: "This affects respond.ts, not attempt.ts").
 *     We still pass `flags.isStreaming` to the provider based on what the
 *     upstream SHOULD do (forceStream OR payload.stream === true) so the
 *     provider negotiates SSE when streaming is wanted — but the
 *     stream-vs-buffer branch is decided by the renderer.
 *
 * Pre-binding errors (model-not-found, no-eligible-binding, no-translator)
 * deliberately omit `performance` per Spec 3 §6.2 — `respond.ts` skips the
 * perf row in that branch. Post-binding errors (upstream 4xx/5xx, terminal
 * decode failures) carry a `performance` ctx so `recordPerformance` writes
 * `isError=true`.
 *
 * Reference: messages/attempt.ts, responses/attempt.ts.
 */
import { runInterceptors, type Invocation, type RequestContext } from '@vnext/interceptor'
import {
  eventResult,
  internalErrorResult,
  readUpstreamError,
  type EndpointKey,
  type ExecuteResult,
  type ModelEndpoints,
  type ProtocolFrame,
} from '@vnext/protocols/common'
import { parseChatCompletionsStream } from '@vnext/protocols/chat'
import { parseMessagesStream } from '@vnext/protocols/messages'
import { parseResponsesStream } from '@vnext/protocols/responses'
import { HTTPError, type ProviderRequest, type ProviderResponse } from '@vnext/provider'
import {
  telemetryModelIdentity,
  upstreamPerformanceContext,
  type AttemptBindingShape,
} from '../shared/attempt-helpers.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { withUpstreamTelemetry } from '../shared/upstream-telemetry'
import { enumerateBindingCandidates, type EnumerateOptions } from '../../routing/candidates.ts'
import { selectPair } from '../../dispatch/pair-selector.ts'
import { getTranslator, type PairTranslator } from '../../dispatch/translator-registry.ts'
import { mapSourceApiToProviderRequest } from '../shared/sse-readers.ts'
import {
  readUpstreamMessagesJson,
  synthesizeMessagesFramesFromJson,
} from '../messages/attempt.ts'
import {
  readUpstreamResponsesJson,
  synthesizeResponsesFramesFromJson,
} from '../responses/attempt.ts'
import { synthesizeChatCompletionsFramesFromJson, type ChatCompletionsJsonBody } from '../chat-completions/events/json-to-frames'

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Gemini attempt produces bare gemini stream events (`GeminiStreamEvent`,
 * typed `unknown` here to avoid pulling the translate package into the
 * attempt surface). `respond.ts` re-encodes them per the gemini SSE wire.
 *
 * Unlike messages/responses, there is no `bridged-response` sentinel —
 * gemini source never has an identity target to bridge around.
 */
export type GeminiAttemptResult = ExecuteResult<unknown>

export interface GeminiAttemptAuth {
  readonly ownerId?: string
  readonly pin?: string
  readonly copilot?: EnumerateOptions['copilot']
  readonly apiKeyId?: string
}

export interface GeminiAttemptArgs {
  readonly payload: Record<string, unknown> & { stream?: boolean }
  /**
   * Bare model name (without provider routing prefix). Comes from the URL path
   * (`/v1beta/models/<model>:generateContent`) — Gemini payloads don't carry
   * a `model` field, so `serve.ts` extracts it from the route and passes it
   * here. Used both for binding selection and for the translator's
   * `ctx.model` (which several gemini-via translators echo back into the
   * response envelope).
   */
  readonly model: string
  /**
   * True when the URL verb is `streamGenerateContent` (client wants SSE).
   * Forwarded to the provider as `flags.isStreaming` so the upstream knows
   * to stream; whether to actually render SSE vs JSON is owned by respond.ts.
   */
  readonly forceStream: boolean
  readonly auth: GeminiAttemptAuth
  readonly ctx: RequestContext
  readonly telemetryCtx: TelemetryRequestContext
  /** Optional binding selector (testable). */
  readonly selectBinding?: SelectGeminiBinding
  /** Overridable interceptor chain; defaults to an empty chain (terminal-only). */
  readonly interceptors?: ReadonlyArray<GeminiInterceptor>
}

// Stream-interceptor stub mirrors messages/responses — Spec 3 keeps the
// minimum scope. No gemini-specific interceptors are registered yet.
export type GeminiInterceptor = (
  inv: Invocation,
  ctx: RequestContext,
  next: (inv: Invocation, ctx: RequestContext) => Promise<ExecuteResult<unknown>>,
) => Promise<ExecuteResult<unknown>>

// ─── Binding selection ───────────────────────────────────────────────────

export type SelectGeminiBindingResult =
  | { kind: 'ok'; binding: AttemptBindingShape & { readonly provider: { readonly fetch: (req: ProviderRequest) => Promise<ProviderResponse>; readonly getPricingForModelKey: (k: string) => unknown | null } }; targetEndpoint: EndpointKey; translator: PairTranslator; bareModel: string }
  | { kind: 'model-not-found'; bareModel: string }
  | { kind: 'no-eligible-binding'; bareModel: string }
  | { kind: 'no-translator'; bareModel: string; targetEndpoint: EndpointKey }

export type SelectGeminiBinding = (
  args: { model: string; auth: GeminiAttemptAuth },
) => Promise<SelectGeminiBindingResult>

const pickTargetForGemini = (endpoints: ModelEndpoints): EndpointKey | null =>
  selectPair('gemini', endpoints)

const defaultSelectBinding: SelectGeminiBinding = async ({ model, auth }) => {
  const { candidates, sawModel, bareModel } = await enumerateBindingCandidates({
    model,
    pickTarget: pickTargetForGemini,
    opts: {
      ownerId: auth.ownerId,
      copilot: auth.copilot,
      pin: auth.pin,
    },
  })
  if (!sawModel) return { kind: 'model-not-found', bareModel }
  const first = candidates[0]
  if (!first) return { kind: 'no-eligible-binding', bareModel }
  const translator = getTranslator('gemini', first.targetEndpoint)
  if (!translator) return { kind: 'no-translator', bareModel, targetEndpoint: first.targetEndpoint }
  return {
    kind: 'ok',
    binding: first.binding as never,
    targetEndpoint: first.targetEndpoint,
    translator,
    bareModel,
  }
}

// ─── Upstream stream parsing ─────────────────────────────────────────────

/**
 * Pick the correct hub-shape protocol-frame parser for the chosen target
 * endpoint. The wrapped frames feed `withUpstreamTelemetry({protocol: hub})`,
 * which uses the hub's terminal-frame classifier + usage extractor — no
 * gemini-side telemetry code is needed because the wire IS the hub wire.
 */
function parseHubStream(
  target: EndpointKey,
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<ProtocolFrame<unknown>> {
  if (target === 'messages') {
    return parseMessagesStream(body, { signal }) as AsyncIterable<ProtocolFrame<unknown>>
  }
  if (target === 'chat_completions') {
    return parseChatCompletionsStream(body, { signal }) as AsyncIterable<ProtocolFrame<unknown>>
  }
  if (target === 'responses') {
    return parseResponsesStream(body, { signal }) as AsyncIterable<ProtocolFrame<unknown>>
  }
  // Unreachable — selectPair('gemini', …) only returns one of the above.
  throw new Error(`gemini attempt: unsupported target endpoint "${target}"`)
}

/**
 * Buffer the upstream JSON body and synthesise the equivalent hub-shape SSE
 * frame sequence. Keeps the gemini attempt's downstream pipeline (`withUpstreamTelemetry`
 * → `unwrapHubFrames` → `translator.translateEvents`) identical between
 * streamed and buffered-JSON upstreams. Mirrors the messages/responses
 * non-stream branches (their attempt.ts handles this for native targets;
 * we delegate to the same exported helpers for cross-protocol gemini routes).
 */
async function synthesizeHubFramesFromJson(
  target: EndpointKey,
  body: ReadableStream<Uint8Array>,
): Promise<AsyncIterable<ProtocolFrame<unknown>>> {
  if (target === 'messages') {
    const json = await readUpstreamMessagesJson(body)
    return synthesizeMessagesFramesFromJson(json) as AsyncIterable<ProtocolFrame<unknown>>
  }
  if (target === 'responses') {
    const json = await readUpstreamResponsesJson(body)
    return synthesizeResponsesFramesFromJson(json) as AsyncIterable<ProtocolFrame<unknown>>
  }
  if (target === 'chat_completions') {
    const buf = await new Response(body).text()
    const json = JSON.parse(buf) as ChatCompletionsJsonBody
    return synthesizeChatCompletionsFramesFromJson(json) as AsyncIterable<ProtocolFrame<unknown>>
  }
  throw new Error(`gemini attempt: unsupported target endpoint "${target}"`)
}

/** Pure protocol-name mapper used for the `withUpstreamTelemetry` ctx. */
type HubProtocol = 'chat_completions' | 'messages' | 'responses'
function targetToHubProtocol(target: EndpointKey): HubProtocol {
  if (target === 'messages') return 'messages'
  if (target === 'chat_completions') return 'chat_completions'
  if (target === 'responses') return 'responses'
  throw new Error(`gemini attempt: unsupported target endpoint "${target}"`)
}

/**
 * Unwrap `ProtocolFrame<HubEvent>` → bare hub events. The translator's
 * `translateEvents` signature expects an `AsyncIterable<MessagesEvent>` /
 * `AsyncIterable<unknown>` (bare events, no envelope), so we strip the frame
 * wrapper after telemetry observation. `done` frames (chat_completions
 * terminator) are dropped because the gemini-via-chat translator drives off
 * the openai-chunk shape directly and doesn't expect a sentinel.
 */
async function* unwrapHubFrames<T>(
  frames: AsyncIterable<ProtocolFrame<T>>,
): AsyncGenerator<T> {
  for await (const frame of frames) {
    if (frame.type === 'event') yield frame.event
    // 'done' frames are intentionally dropped here.
  }
}

// ─── Main attempt ─────────────────────────────────────────────────────────

export const geminiAttempt = {
  generate: async (args: GeminiAttemptArgs): Promise<GeminiAttemptResult> => {
    const selectFn = args.selectBinding ?? defaultSelectBinding
    const sel = await selectFn({ model: args.model, auth: args.auth })

    if (sel.kind === 'model-not-found') return internalErrorResult(404, new Error(`model not found: ${sel.bareModel}`))
    if (sel.kind === 'no-eligible-binding') return internalErrorResult(404, new Error(`no eligible binding for: ${sel.bareModel}`))
    if (sel.kind === 'no-translator') return internalErrorResult(500, new Error(`no translator for gemini → ${sel.targetEndpoint}`))

    // Gemini has no identity target — selectPair('gemini', …) never returns
    // 'gemini' — so there's no bridged-response branch. Every successful
    // selection drives the terminal path below.

    const invocation: Invocation = {
      endpoint: sel.targetEndpoint,
      enabledFlags: new Set(),
      sourceApi: 'gemini',
      payload: args.payload as Record<string, unknown>,
      headers: {},
    }
    const chain: ReadonlyArray<GeminiInterceptor> = args.interceptors ?? []

    let upstreamResp: ProviderResponse | undefined

    const terminal = async (): Promise<ExecuteResult<unknown>> => {
      // Translator returns the HUB-shape payload for the upstream call. The
      // gemini-via translators all accept `(payload, {signal, model,
      // fallbackMaxOutputTokens})` — `model` is required because several
      // hub shapes (chat completions, responses) put the model in the payload
      // even though gemini puts it in the URL.
      const translateCtx = {
        signal: args.ctx.downstreamAbortSignal ?? new AbortController().signal,
        model: sel.bareModel,
        fallbackMaxOutputTokens: 4096,
      }
      const upstreamPayload = await sel.translator.translateRequest(
        invocation.payload,
        translateCtx,
      )
      const headers = new Headers({ 'content-type': 'application/json' })
      for (const [k, v] of Object.entries(invocation.headers)) headers.set(k, v)
      // Upstream streams whenever either side wants streaming. respond.ts
      // decides whether the CLIENT sees SSE vs a buffered JSON envelope —
      // the upstream just needs to know "stream the result back so we can
      // render it incrementally".
      const wantsUpstreamStream =
        args.forceStream === true || invocation.payload.stream === true
      const providerReq: ProviderRequest = {
        endpoint: sel.targetEndpoint,
        payload: upstreamPayload,
        headers,
        // The provider tags the request line per upstream taxonomy; gemini
        // sourceApi maps through `mapSourceApiToProviderRequest` (defined in
        // shared/sse-readers.ts) to keep the legacy header set unchanged.
        sourceApi: mapSourceApiToProviderRequest('gemini'),
        flags: { isStreaming: wantsUpstreamStream },
        signal: args.ctx.downstreamAbortSignal,
      }
      const bindingForTelemetry = sel.binding as unknown as AttemptBindingShape
      upstreamResp = await sel.binding.provider.fetch(providerReq)
      if (upstreamResp.status < 200 || upstreamResp.status >= 300) {
        const errResp = new Response(upstreamResp.body, { status: upstreamResp.status, headers: upstreamResp.headers })
        const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
        return await readUpstreamError(errResp, performance)
      }
      if (!upstreamResp.body) {
        const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
        return internalErrorResult(502, new Error('upstream returned empty body'), performance)
      }

      // Parse upstream as HUB-shape protocol frames so the telemetry wrapper
      // can use the hub's already-tested terminal-frame classifier + usage
      // extractor. `targetEndpoint` selects the parser and the protocol
      // ctx in one place — no need to extend `withUpstreamTelemetry`'s
      // protocol union with `'gemini'` because the wire is the hub wire.
      //
      // JSON-vs-SSE detection: gemini-via translators always force
      // `stream: true` on the upstream payload (gemini-via-chat-completions/request.ts:289,
      // gemini-via-responses/request.ts:269), so the client's
      // `wantsUpstreamStream` flag is NOT a reliable proxy for the upstream
      // wire shape. We rely on the upstream's content-type alone: SSE carries
      // `text/event-stream`; anything else (JSON, missing/empty header) is
      // treated as a single JSON envelope and synthesised into hub frames.
      const upstreamContentType = upstreamResp.headers.get('content-type') ?? ''
      const upstreamLooksJson = !upstreamContentType.includes('text/event-stream')

      const hubProtocol = targetToHubProtocol(sel.targetEndpoint)
      const hubFrames = upstreamLooksJson
        ? await synthesizeHubFramesFromJson(sel.targetEndpoint, upstreamResp.body)
        : parseHubStream(
            sel.targetEndpoint,
            upstreamResp.body,
            args.ctx.downstreamAbortSignal,
          )
      const { events: decoratedFrames } = withUpstreamTelemetry(hubFrames, {
        abortSignal: args.ctx.downstreamAbortSignal,
        protocol: hubProtocol,
      })
      // Translator consumes bare hub events (NOT ProtocolFrame). Unwrap after
      // telemetry observation so usage/terminal detection sees every frame
      // but the translator gets the shape it expects.
      const bareHubEvents = unwrapHubFrames(decoratedFrames)
      const geminiEvents = sel.translator.translateEvents(bareHubEvents, translateCtx)

      const modelIdentity = telemetryModelIdentity(bindingForTelemetry, sel.bareModel)
      const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
      // EventResult<unknown>: gemini events are bare GeminiStreamEvent objects
      // (no ProtocolFrame wrapper), matching what `encodeClientSSE('gemini', …)`
      // and the JSON renderer in respond.ts both expect.
      return eventResult(geminiEvents as AsyncIterable<unknown>, modelIdentity, performance)
    }

    try {
      if (chain.length === 0) return await terminal()
      // Adapter: runInterceptors expects a `ChatCompletionsStreamInterceptor`-
      // shaped chain. No gemini interceptors are registered yet — this
      // branch is reachable only via tests injecting `args.interceptors`.
      return await runInterceptors(
        invocation,
        args.ctx,
        chain as never,
        terminal as never,
      )
    } catch (err) {
      if (upstreamResp?.body) void upstreamResp.body.cancel().catch(() => {})
      const bindingForTelemetry = sel.binding as unknown as AttemptBindingShape
      const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
      // HTTPError is the legacy provider contract for upstream non-2xx; the
      // ProviderResponse-based branch above already covers the new contract,
      // but we keep this guard for providers that still throw.
      if (err instanceof HTTPError) return await readUpstreamError(err.response, performance)
      return internalErrorResult(502, err instanceof Error ? err : new Error(String(err)), performance)
    }
  },
}
