import { AffinityRoutingUnavailableError } from "../../../shared/affinity/analysis.ts"
import { affinityExecutionState, materializeAffinity, fetchAffinityUpstream, affinityFence, acceptAffinityExecution, type AttemptAffinity } from "../../shared/affinity-request"
import { selectedTierFrames } from "../shared/execution-tier"
import type { DumpAccumulator } from "../../../shared/dump/accumulator.ts"
import { invocationSourceApi } from '../shared/invocation-source-api'
import { responsesFormatGuard, responsesFormatMismatchMessage } from '@vibe-llm/provider-llm'
import { TranslatorValidationError } from '@vibe-llm/translate/errors'
import { getTranslator } from '../../dispatch/translator-registry.ts'
import { MODEL_CATALOG_UNAVAILABLE } from '../../errors/model-catalog.ts'
import { fetchWithPerformance, observeUpstreamFrames, observeUpstreamJson } from "../shared/performance-upstream"
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
import { runInterceptors } from '@vibe-core/service'
import type { ChatCompletionsStreamInterceptor, Invocation, RequestContext } from '@vibe-llm/protocols/common'
import { llmEventResult, llmInternalErrorResult, readUpstreamError, type LlmExecuteResult } from '@vibe-llm/protocols/common'
import { type ProtocolFrame } from '@vibe-core/result'
import { parseChatCompletionsStream, type ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'
import { HTTPError, type ProviderRequest, type ProviderResponse } from '@vibe-llm/provider-llm'
import {
  initialProviderModelKey,
  telemetryModelIdentity,
  modelIdentityResolver,
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
  readonly affinity?: AttemptAffinity
  readonly affinityMaterialized?: boolean
  readonly dump?: DumpAccumulator | null
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
  readonly selectBinding?: (args: { model: string; auth: ChatCompletionsAttemptAuth; dump?: DumpAccumulator | null }) => Promise<SelectBindingResult>
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
  response?: ProviderResponse,
): Promise<AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
  const buf = await new Response(body).text()
  const json = JSON.parse(buf) as ChatCompletionsJsonBody
  if (response) observeUpstreamJson(response, json)
  return synthesizeChatCompletionsFramesFromJson(json)
}

export const chatCompletionsAttempt = {
  generate: async (args: ChatCompletionsAttemptArgs): Promise<ChatCompletionsAttemptResult> => {
    const selectFn = args.selectBinding ?? ((a) => selectBindingForChatCompletions({ ...a, affinity: args.affinity, affinityOptions: { signal: args.ctx.downstreamAbortSignal, inheritedHeaders: args.inheritedHeaders } }))
    let sel: Awaited<ReturnType<typeof selectFn>>
    try {
      sel = await selectFn({ model: args.payload.model, auth: args.auth, dump: args.dump })
    } catch (error) {
      if (error instanceof AffinityRoutingUnavailableError) return llmInternalErrorResult(error.status, error)
      throw error
    }

    if (sel.kind === 'catalog-unavailable') return llmInternalErrorResult(503, new Error(MODEL_CATALOG_UNAVAILABLE))
    if (sel.kind === 'model-not-found') return llmInternalErrorResult(404, new Error(`model not found: ${sel.bareModel}`))
    if (sel.kind === 'no-eligible-binding') return llmInternalErrorResult(404, new Error(`no eligible binding for: ${sel.bareModel}`))
    if (sel.kind === 'no-translator') return llmInternalErrorResult(500, new Error(`no translator for chat_completions → ${sel.targetEndpoint}`))

    const payload = args.affinityMaterialized ? args.payload : materializeAffinity(args.affinity, args.payload, sel.bareModel)
    const affinityExecution = affinityExecutionState(args.affinity)
    const { downstreamAbortSignal, abortUpstream } = args.ctx
    const telemetryCtx = args.telemetryCtx

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
        dump: args.dump,
        sourcePayload: payload,
        sourceProtocol: 'chat_completions',
        hubProtocol,
        translator: sel.translator,
        innerAttempt: async (innerArgs) => {
          return (await hubAttempt.generate({
            selectBinding: async () => ({ ...sel, translator: getTranslator(hubProtocol, hubProtocol)! }),
            payload: innerArgs.payload as never,
            affinity: affinityExecution,
            affinityMaterialized: true,
            auth: innerArgs.auth as never,
            ctx: { downstreamAbortSignal: innerArgs.signal, abortUpstream } as never,
            dump: innerArgs.dump,
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
      enabledFlags: new Set(sel.binding.enabledFlags ?? []),
      sourceApi: invocationSourceApi(args.telemetryCtx.sourceApi, 'chat_completions'),
      payload,
      headers: { ...(args.inheritedHeaders ?? {}) },
    }
    const chain = args.interceptors ?? chatCompletionsInterceptors

    // Lifted so the outer catch can cancel the upstream body if a wrapping
    // interceptor throws AFTER the terminal opened it. Without this, the
    // upstream stream lingers until GC.
    let upstreamResp: ProviderResponse | undefined

    const preservesFormat = responsesFormatGuard(invocation.sourceApi, invocation.endpoint, invocation.payload)

    const terminal = async (): Promise<LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
      const upstreamPayload = await sel.translator.translateRequest(invocation.payload, {
        signal: downstreamAbortSignal ?? new AbortController().signal,
      })
      if (!preservesFormat(upstreamPayload)) {
        return llmInternalErrorResult(400, new TranslatorValidationError(responsesFormatMismatchMessage, 'text.format'), undefined, 'translator-validation')
      }
      const headers = new Headers({ 'content-type': 'application/json' })
      for (const [k, v] of Object.entries(invocation.headers)) headers.set(k, v)
      const providerReq: ProviderRequest = {
        beforeInference: affinityFence(affinityExecution),
        endpoint: 'chat_completions',
        payload: upstreamPayload,
        headers,
        sourceApi: 'openai',
        sourceProtocol: invocation.sourceApi,
        flags: { isStreaming: invocation.payload.stream === true },
        signal: downstreamAbortSignal,
      }
      const binding = sel.binding as unknown as AttemptBinding
      // Cast once to the shape the telemetry helpers consume (provider.fetch
      // returns a structurally-equivalent LlmProviderBinding; we only depend on
      // upstream.name + upstreamModel.id + provider.getPricingForModelKey).
      const bindingForTelemetry = sel.binding as unknown as AttemptBindingShape
      const publicModel = sel.bareModel
      upstreamResp = await fetchWithPerformance(telemetryCtx.metrics, "chat_completions", providerReq, () => fetchAffinityUpstream(affinityExecution, providerReq, request => binding.provider.fetch(request)))
      if (upstreamResp.status >= 200 && upstreamResp.status < 300) acceptAffinityExecution(affinityExecution, upstreamResp)
      const execution = upstreamResp.execution ? Object.freeze({ ...upstreamResp.execution }) : undefined
      const providerModelKey = execution?.modelKey ?? initialProviderModelKey(bindingForTelemetry, publicModel)
      if (upstreamResp.status < 200 || upstreamResp.status >= 300) {
        // Wrap the ProviderResponse shape into a Response so readUpstreamError
        // can buffer body + headers using the standard helper. The performance
        // ctx flows through so respond.ts can write a `failed=true` perf row
        // without losing keyId/upstream/runtime.
        const errResp = new Response(upstreamResp.body, { status: upstreamResp.status, headers: upstreamResp.headers })
        const performance = upstreamPerformanceContext(telemetryCtx, bindingForTelemetry, providerModelKey, publicModel)
        return await readUpstreamError(errResp, performance)
      }
      if (!upstreamResp.body) {
        const performance = upstreamPerformanceContext(telemetryCtx, bindingForTelemetry, providerModelKey, publicModel)
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
      const upstreamIsJson = !upstreamContentType.includes('text/event-stream') && (
        invocation.payload.stream !== true || upstreamContentType.includes('application/json')
      )
      const stream = upstreamIsJson
        ? await readUpstreamJsonAsFrames(upstreamResp.body, upstreamResp)
        : parseChatCompletionsStream(upstreamResp.body, { signal: downstreamAbortSignal })
      const { events: decorated } = withUpstreamTelemetry(observeUpstreamFrames(upstreamResp, selectedTierFrames("chat_completions", stream, execution?.serviceTier), upstreamIsJson), {
        abortSignal: downstreamAbortSignal,
        onFailure: abortUpstream,
        protocol: 'chat_completions',
        expectedChoices: typeof invocation.payload.n === 'number' ? invocation.payload.n : 1,
      })
      const identityInput = { incomingModel: telemetryCtx.incomingModel, publicModel }
      const modelIdentity = telemetryModelIdentity(bindingForTelemetry, providerModelKey, identityInput, execution)
      const performance = upstreamPerformanceContext(telemetryCtx, bindingForTelemetry, providerModelKey, publicModel)
      return llmEventResult(
        decorated,
        modelIdentity,
        performance,
        undefined,
        undefined,
        undefined,
        modelIdentityResolver(bindingForTelemetry, identityInput, execution),
      )
    }

    try {
      const chainCtx: RequestContext = { ...args.ctx, targetEndpoint: sel.targetEndpoint }
      return await runInterceptors(invocation, chainCtx, chain, terminal)
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
      const publicModel = sel.bareModel
      const providerModelKey = initialProviderModelKey(bindingForTelemetry, publicModel)
      const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, providerModelKey, publicModel)
      // Providers throw `HTTPError` for upstream non-2xx (matches the legacy
      // `dispatch()` contract). Surface it as an `UpstreamErrorResult` so
      // respond.ts can preserve the original status (400/401/etc.) and body
      // instead of collapsing every upstream error to a generic 502.
      if (err instanceof HTTPError) return await readUpstreamError(err.response, performance)
      return llmInternalErrorResult(502, err instanceof Error ? err : new Error(String(err)), performance)
    }
  },
}
