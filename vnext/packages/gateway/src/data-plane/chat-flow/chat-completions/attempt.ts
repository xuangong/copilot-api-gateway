// vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts
/**
 * Chat Completions attempt orchestrator.
 *
 * Builds an `Invocation`, runs `chatCompletionsInterceptors`, and (in the
 * terminal handler) issues the upstream call via the resolved provider.
 *
 * For cross-protocol targets (e.g. `chat_completions → messages` /
 * `chat_completions → responses`) the attempt delegates to
 * `traverseTranslation`, which calls the source translator to produce a
 * hub-protocol payload, runs the hub attempt, and wraps the returned event
 * stream with the translator's event mapper so the source sees its native
 * frames. See Spec 6 §3.4.
 *
 * Reference: copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/attempt.ts
 */
import { runInterceptors } from '@vnext-gateway/service'
import type { ChatCompletionsStreamInterceptor, Invocation, RequestContext } from '@vnext-llm/protocols/common'
import { llmEventResult, llmInternalErrorResult, readUpstreamError, type LlmExecuteResult } from '@vnext-llm/protocols/common'
import { type ProtocolFrame } from '@vnext-gateway/result'
import { parseChatCompletionsStream, type ChatCompletionsStreamEvent } from '@vnext-llm/protocols/chat'
import { HTTPError, type ProviderRequest, type ProviderResponse } from '@vnext-llm/provider-llm'
import {
  telemetryModelIdentity,
  upstreamPerformanceContext,
  type AttemptBindingShape,
} from '../shared/attempt-helpers.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { withUpstreamTelemetry } from '../shared/upstream-telemetry'
import { selectBindingForChatCompletions, type SelectBindingAuth, type SelectBindingResult } from '../shared/select-binding'
import { chatCompletionsInterceptors } from './interceptors'
import { synthesizeChatCompletionsFramesFromJson, type ChatCompletionsJsonBody } from './events/json-to-frames'
import { traverseTranslation } from '../shared/traverse-translation.ts'
import { pickHubAttempt, type HubAttemptProtocol } from '../shared/hub-attempt-dispatch.ts'

export type ChatCompletionsAttemptResult = LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>

// Reuses the routing helper's auth shape so we never lose detail when the
// terminal hands the same value back to `selectBindingForChatCompletions`.
export type ChatCompletionsAttemptAuth = SelectBindingAuth

export interface ChatCompletionsAttemptArgs {
  readonly payload: Record<string, unknown> & { model: string; stream?: boolean }
  readonly auth: ChatCompletionsAttemptAuth
  readonly ctx: RequestContext
  /**
   * Telemetry context built once in serve.ts. Threaded into the resulting
   * `LlmEventResult.performance` / `UpstreamErrorResult.performance` so respond.ts
   * can persist usage + perf rows with the right keyId/upstream/runtime.
   */
  readonly telemetryCtx: TelemetryRequestContext
  /** Injected for tests; defaults to {@link selectBindingForChatCompletions}. */
  readonly selectBinding?: (args: { model: string; auth: ChatCompletionsAttemptAuth }) => Promise<SelectBindingResult>
  /** Overridable interceptor chain (defaults to the production registry). */
  readonly interceptors?: ReadonlyArray<ChatCompletionsStreamInterceptor>
  readonly inheritedHeaders?: Record<string, string>
  readonly snapshotMode?: 'none'
  /**
   * Test seam for cross-protocol dispatch. When the resolved binding routes to
   * a non-`chat_completions` hub, the attempt looks up the hub attempt via
   * this override (if provided) or {@link pickHubAttempt} otherwise. Production
   * code never sets this; tests inject a fake hub attempt to keep the
   * cross-protocol contract independent of the real messages/responses
   * attempt implementations.
   */
  readonly hubAttemptOverride?: (p: HubAttemptProtocol) => { generate: (a: never) => Promise<never> }
}

// Minimal binding shape we actually depend on. Keeps tests free of the full
// LlmProviderBinding ceremony while staying type-safe inside this module.
type AttemptBinding = { readonly provider: { readonly fetch: (req: ProviderRequest) => Promise<ProviderResponse> } }

// Buffer the upstream body, decode as a `chat.completion` envelope, and hand
// it to the JSON→frames synthesizer. Returns the same async-iterable shape as
// `parseChatCompletionsStream` so the rest of the terminal stays branch-free.
// Any decode failure surfaces as a `parseChatCompletionsStream`-shaped error
// (single throw on iteration), which the outer try/catch maps to a 502.
const readUpstreamJsonAsFrames = async (
  body: ReadableStream<Uint8Array>,
): Promise<AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
  const buf = await new Response(body).text()
  const json = JSON.parse(buf) as ChatCompletionsJsonBody
  return synthesizeChatCompletionsFramesFromJson(json)
}

export const chatCompletionsAttempt = {
  generate: async (args: ChatCompletionsAttemptArgs): Promise<ChatCompletionsAttemptResult> => {
    const selectFn = args.selectBinding ?? ((a) => selectBindingForChatCompletions(a))
    const sel = await selectFn({ model: args.payload.model, auth: args.auth })

    if (sel.kind === 'model-not-found') return llmInternalErrorResult(404, new Error(`model not found: ${sel.bareModel}`))
    if (sel.kind === 'no-eligible-binding') return llmInternalErrorResult(404, new Error(`no eligible binding for: ${sel.bareModel}`))
    if (sel.kind === 'no-translator') return llmInternalErrorResult(500, new Error(`no translator for chat_completions → ${sel.targetEndpoint}`))

    if (sel.targetEndpoint !== 'chat_completions') {
      // Cross-protocol attempt: delegate to the hub attempt via
      // `traverseTranslation`. The translator shapes the request payload into
      // the hub protocol, the hub attempt issues the upstream call, then the
      // translator's event mapper rewraps the returned event stream so the
      // chat_completions caller still sees its native frames. See Spec 6 §3.4.
      //
      // `sel.targetEndpoint` is typed as the wide `EndpointKey` (includes
      // embeddings/images), but `pickTargetForChatCompletions` filters the
      // selection to the chat-flow subset (`chat_completions | messages |
      // responses`). The cast narrows the type to what
      // `pickHubAttempt`/`traverseTranslation` accept.
      const hubProtocol = sel.targetEndpoint as HubAttemptProtocol
      const hubAttempt = (args.hubAttemptOverride ?? pickHubAttempt)(hubProtocol)
      return await traverseTranslation({
        sourcePayload: args.payload as Record<string, unknown>,
        sourceProtocol: 'chat_completions',
        hubProtocol,
        translator: sel.translator,
        innerAttempt: async (innerArgs) => {
          return (await hubAttempt.generate({
            payload: innerArgs.payload as never,
            auth: innerArgs.auth as never,
            ctx: { downstreamAbortSignal: innerArgs.signal } as never,
            telemetryCtx: innerArgs.inheritedTelemetryCtx,
            inheritedHeaders: innerArgs.inheritedHeaders,
            snapshotMode: innerArgs.snapshotMode,
          } as never)) as never
        },
        inheritedHeaders: args.inheritedHeaders ?? {},
        inheritedTelemetryCtx: args.telemetryCtx,
        auth: args.auth,
        signal: args.ctx.downstreamAbortSignal,
        fallbackMaxOutputTokens: (sel.binding as { upstreamMaxOutputTokens?: number }).upstreamMaxOutputTokens,
        model: sel.bareModel,
      })
    }

    const invocation: Invocation = {
      endpoint: 'chat_completions',
      enabledFlags: new Set(),
      sourceApi: 'chat_completions',
      payload: args.payload as Record<string, unknown>,
      headers: { ...(args.inheritedHeaders ?? {}) },
    }
    const chain = args.interceptors ?? chatCompletionsInterceptors

    // Lifted so the outer catch can cancel the upstream body if a wrapping
    // interceptor throws AFTER the terminal opened it. Without this, the
    // upstream stream lingers until GC.
    let upstreamResp: ProviderResponse | undefined

    const terminal = async (): Promise<LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
      const upstreamPayload = await sel.translator.translateRequest(invocation.payload, {
        signal: args.ctx.downstreamAbortSignal ?? new AbortController().signal,
      })
      const headers = new Headers({ 'content-type': 'application/json' })
      for (const [k, v] of Object.entries(invocation.headers)) headers.set(k, v)
      const providerReq: ProviderRequest = {
        endpoint: 'chat_completions',
        payload: upstreamPayload,
        headers,
        sourceApi: 'openai',
        flags: { isStreaming: invocation.payload.stream === true },
        signal: args.ctx.downstreamAbortSignal,
      }
      const binding = sel.binding as unknown as AttemptBinding
      // Cast once to the shape the telemetry helpers consume (provider.fetch
      // returns a structurally-equivalent LlmProviderBinding; we only depend on
      // upstream.name + upstreamModel.id + provider.getPricingForModelKey).
      const bindingForTelemetry = sel.binding as unknown as AttemptBindingShape
      upstreamResp = await binding.provider.fetch(providerReq)
      if (upstreamResp.status < 200 || upstreamResp.status >= 300) {
        // Wrap the ProviderResponse shape into a Response so readUpstreamError
        // can buffer body + headers using the standard helper. The performance
        // ctx flows through so respond.ts can write a `failed=true` perf row
        // without losing keyId/upstream/runtime.
        const errResp = new Response(upstreamResp.body, { status: upstreamResp.status, headers: upstreamResp.headers })
        const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
        return await readUpstreamError(errResp, performance)
      }
      if (!upstreamResp.body) {
        const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
        return llmInternalErrorResult(502, new Error('upstream returned empty body'), performance)
      }
      // Non-streaming requests (or unexpectedly-JSON responses) need to be
      // funneled through the SAME ProtocolFrame pipeline the SSE path uses,
      // so interceptors and `collectChatCompletionsProtocolEventsToResult`
      // don't see two parallel shapes. We sniff content-type first (matches
      // legacy `dispatch()`'s upstream-payload-driven branch) and fall back to
      // synthesizing frames from the buffered JSON.
      //
      // Why not always sniff: when content-type is text/event-stream we MUST
      // hand the body to `parseChatCompletionsStream` lazily — buffering would
      // serialize the upstream and defeat first-byte-latency telemetry.
      const upstreamContentType = upstreamResp.headers.get('content-type') ?? ''
      const upstreamIsJson =
        invocation.payload.stream !== true ||
        upstreamContentType.includes('application/json')
      const stream = upstreamIsJson
        ? await readUpstreamJsonAsFrames(upstreamResp.body)
        : parseChatCompletionsStream(upstreamResp.body, { signal: args.ctx.downstreamAbortSignal })
      const { events: decorated } = withUpstreamTelemetry(stream, {
        abortSignal: args.ctx.downstreamAbortSignal,
        protocol: 'chat_completions',
      })
      const modelIdentity = telemetryModelIdentity(bindingForTelemetry, sel.bareModel)
      const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
      return llmEventResult(decorated, modelIdentity, performance)
    }

    try {
      return await runInterceptors(invocation, args.ctx, chain, terminal)
    } catch (err) {
      // If terminal opened an upstream body but a wrapping interceptor threw
      // before anyone could consume it, cancel to release the connection.
      // Swallow cancel errors (body may be locked or already cancelled).
      if (upstreamResp?.body) void upstreamResp.body.cancel().catch(() => {})
      // Errors caught here are post-binding-selection — surface a `performance`
      // ctx so respond.ts can persist a `failed=true` perf row. Pre-binding
      // errors (model-not-found, etc.) returned earlier above deliberately
      // omit `performance` per spec §6.2.
      const bindingForTelemetry = sel.binding as unknown as AttemptBindingShape
      const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
      // Providers throw `HTTPError` for upstream non-2xx (matches the legacy
      // `dispatch()` contract). Surface it as an `UpstreamErrorResult` so
      // respond.ts can preserve the original status (400/401/etc.) and body
      // instead of collapsing every upstream error to a generic 502.
      if (err instanceof HTTPError) return await readUpstreamError(err.response, performance)
      return llmInternalErrorResult(502, err instanceof Error ? err : new Error(String(err)), performance)
    }
  },
}
