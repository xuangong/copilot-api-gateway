// vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts
/**
 * /v1/responses attempt orchestrator.
 *
 * Mirrors `messages/attempt.ts` (Spec 3 Part 3 Task 1) but specialised for the
 * Responses source:
 *   - source preference is `responses → messages → chat_completions` (per
 *     `pair-selector.ts`);
 *   - identity target (`responses → responses`) parses the upstream SSE body
 *     via `parseResponsesStream`, decorates with `withUpstreamTelemetry({protocol:
 *     'responses'})`, and emits an `EventResult<ProtocolFrame<ResponsesStreamEvent>>`;
 *   - cross-protocol targets (`responses → messages` / `responses →
 *     chat_completions`) are NOT yet supported natively — Spec 3 Part 4
 *     deleted the legacy `dispatch()` bridge but native cross-protocol
 *     attempts are deferred to Spec 6. We surface a 501-shaped
 *     internal-error result so the failure mode is loud and the abandoned
 *     response is fully accounted for in telemetry;
 *   - `image_generation` server-tool requests short-circuit via
 *     `runImageGenerationShortcut` BEFORE binding selection — the shortcut
 *     owns its own modelIdentity + performance via `finalMetadata` and the
 *     `__interceptorReplaced` provenance flag. The shortcut produces the
 *     same `bridged-response` sentinel for early failures (validation, no
 *     binding) so respond.ts hands them through unchanged.
 *
 * Pre-binding errors (model-not-found, no-eligible-binding, no-translator)
 * deliberately omit `performance` per Spec 3 §6.2 — `respond.ts` skips the
 * perf row in that branch. Post-binding errors (upstream 4xx/5xx, terminal
 * decode failures) carry a `performance` ctx so `recordPerformance` writes
 * `isError=true`.
 *
 * Reference: messages/attempt.ts.
 */
import { runInterceptors } from '@vnext-gateway/service'
import type { Invocation, RequestContext } from '@vnext-llm/protocols/common'
import { responsesInterceptors, type ResponsesInterceptor } from './interceptors'
import {
  eventFrame,
  eventResult,
  internalErrorResult,
  readUpstreamError,
  type EndpointKey,
  type ExecuteResult,
  type ModelEndpoints,
  type ProtocolFrame,
} from '@vnext-llm/protocols/common'
import {
  parseResponsesStream,
  responsesResultToEvents,
  type ResponsesStreamEvent,
  type ResponsesResult,
} from '@vnext-llm/protocols/responses'
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
import {
  isImageGenerationRequest,
  runImageGenerationShortcut,
} from './image-generation-shortcut.ts'
import type { CreateProviderOptions } from '../../providers/registry.ts'
import { traverseTranslation } from '../shared/traverse-translation.ts'
import { pickHubAttempt, type HubAttemptProtocol } from '../shared/hub-attempt-dispatch.ts'

// ─── Public types ─────────────────────────────────────────────────────────

export type ResponsesAttemptResult =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | { readonly kind: 'bridged-response'; readonly response: Response }

export interface ResponsesAttemptAuth {
  readonly ownerId?: string
  readonly pin?: string
  readonly copilot?: EnumerateOptions['copilot']
  readonly apiKeyId?: string
}

export interface ResponsesAttemptArgs {
  readonly payload: Record<string, unknown> & { model: string; stream?: boolean; input?: unknown; tools?: unknown }
  readonly auth: ResponsesAttemptAuth
  readonly ctx: RequestContext
  readonly telemetryCtx: TelemetryRequestContext
  /** Optional binding selector (testable). */
  readonly selectBinding?: SelectResponsesBinding
  /** Overridable interceptor chain; defaults to an empty chain (terminal-only). */
  readonly interceptors?: ReadonlyArray<ResponsesInterceptor>
  /** Optional User-Agent passthrough so the image-gen shortcut can echo it into upstream image calls. */
  readonly userAgent?: string
  /** Optional request id passthrough so the image-gen shortcut can stamp it on upstream image calls. */
  readonly requestId?: string
  readonly inheritedHeaders?: Record<string, string>
  readonly snapshotMode?: 'none'
  /**
   * Test seam for cross-protocol dispatch. When the resolved binding routes to
   * a non-`responses` hub, the attempt looks up the hub attempt via this
   * override (if provided) or {@link pickHubAttempt} otherwise. Production
   * code never sets this; tests inject a fake hub attempt to keep the
   * cross-protocol contract independent of the real messages/chat_completions
   * attempt implementations.
   */
  readonly hubAttemptOverride?: (p: HubAttemptProtocol) => { generate: (a: never) => Promise<never> }
}

// Stream-interceptor type re-exported from the registry module (Batch 4).
export type { ResponsesInterceptor } from './interceptors'

// ─── Binding selection ───────────────────────────────────────────────────

export type SelectResponsesBindingResult =
  | { kind: 'ok'; binding: AttemptBindingShape & { readonly provider: { readonly fetch: (req: ProviderRequest) => Promise<ProviderResponse>; readonly getPricingForModelKey: (k: string) => unknown | null } }; targetEndpoint: EndpointKey; translator: PairTranslator; bareModel: string }
  | { kind: 'model-not-found'; bareModel: string }
  | { kind: 'no-eligible-binding'; bareModel: string }
  | { kind: 'no-translator'; bareModel: string; targetEndpoint: EndpointKey }

export type SelectResponsesBinding = (
  args: { model: string; auth: ResponsesAttemptAuth },
) => Promise<SelectResponsesBindingResult>

const pickTargetForResponses = (endpoints: ModelEndpoints): EndpointKey | null =>
  selectPair('responses', endpoints)

const defaultSelectBinding: SelectResponsesBinding = async ({ model, auth }) => {
  const { candidates, sawModel, bareModel } = await enumerateBindingCandidates({
    model,
    pickTarget: pickTargetForResponses,
    opts: {
      ownerId: auth.ownerId,
      copilot: auth.copilot,
      pin: auth.pin,
    },
  })
  if (!sawModel) return { kind: 'model-not-found', bareModel }
  const first = candidates[0]
  if (!first) return { kind: 'no-eligible-binding', bareModel }
  const translator = getTranslator('responses', first.targetEndpoint)
  if (!translator) return { kind: 'no-translator', bareModel, targetEndpoint: first.targetEndpoint }
  return {
    kind: 'ok',
    binding: first.binding as never,
    targetEndpoint: first.targetEndpoint,
    translator,
    bareModel,
  }
}

// ─── Streaming/JSON branching helpers ────────────────────────────────────

/**
 * Buffer the upstream body and decode as a Responses JSON envelope. Surfaces
 * a `JSON.parse` error to the caller so attempt.ts's outer try/catch can map
 * it to an internal-error result populated with `performance` ctx (parity
 * with the messages JSON branch).
 *
 * Exported for cross-protocol reuse by `gemini/attempt.ts` when its hub target
 * is `responses`.
 */
export async function readUpstreamResponsesJson(
  body: ReadableStream<Uint8Array>,
): Promise<ResponsesResult> {
  const buf = await new Response(body).text()
  return JSON.parse(buf) as ResponsesResult
}

/**
 * Synthesise the SSE event sequence a Responses-native client would have seen
 * if upstream had streamed instead of returning JSON. Uses the protocol-side
 * `responsesResultToEvents` helper so we keep a single source of truth for
 * the Responses event taxonomy. Wrapped in an async generator so respond.ts's
 * `consumeWithState` + `withUpstreamTelemetry` plumbing works identically with
 * the SSE path.
 *
 * Uses `genericOutputItems: true` because the upstream JSON body is the
 * authoritative shape we want to round-trip — the per-item child-event
 * expansion (`responsesMessageEvents` / etc.) requires every output item to
 * carry an `id`, which real-world non-stream replies routinely omit. Generic
 * mode emits only `output_item.added` / `output_item.done` with the item
 * verbatim, which is exactly what `collectResponsesProtocolEventsToResult`
 * needs to reassemble the original JSON envelope. The terminal lifecycle
 * frame (`response.completed` / `incomplete` / `failed`) still carries the
 * full `ResponsesResult`, so reassembly remains correct.
 *
 * Exported for cross-protocol reuse by `gemini/attempt.ts` (see above).
 */
export async function* synthesizeResponsesFramesFromJson(
  body: ResponsesResult,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const frame of responsesResultToEvents(body, { genericOutputItems: true })) yield frame
  // responsesResultToEvents already emits the terminal envelope
  // (`response.completed` / `response.failed` / `response.incomplete` per
  // body.status) so we don't append our own — it would duplicate the terminal
  // event and confuse `withUpstreamTelemetry`'s classifier.
  void eventFrame // keep import live for tooling parity with messages/attempt.ts
}

// ─── Main attempt ─────────────────────────────────────────────────────────

export const responsesAttempt = {
  generate: async (args: ResponsesAttemptArgs): Promise<ResponsesAttemptResult> => {
    // Image-generation server-tool short-circuit: runs BEFORE binding
    // selection because the image-gen shortcut resolves its own (image-only)
    // binding through `images_generations` / `images_edits` endpoint keys,
    // not the `responses` endpoint we'd pick for a regular text turn.
    if (isImageGenerationRequest(args.payload)) {
      return await runImageGenerationShortcut({
        payload: args.payload as Parameters<typeof runImageGenerationShortcut>[0]['payload'],
        auth: {
          userId: args.auth.ownerId,
          copilot: args.auth.copilot as CreateProviderOptions | undefined,
          apiKeyId: args.auth.apiKeyId,
        },
        telemetryCtx: args.telemetryCtx,
        requestId: args.requestId,
        userAgent: args.userAgent,
      })
    }

    const selectFn = args.selectBinding ?? defaultSelectBinding
    const sel = await selectFn({ model: args.payload.model, auth: args.auth })

    if (sel.kind === 'model-not-found') return internalErrorResult(404, new Error(`model not found: ${sel.bareModel}`))
    if (sel.kind === 'no-eligible-binding') return internalErrorResult(404, new Error(`no eligible binding for: ${sel.bareModel}`))
    if (sel.kind === 'no-translator') return internalErrorResult(500, new Error(`no translator for responses → ${sel.targetEndpoint}`))

    if (sel.targetEndpoint !== 'responses') {
      // Cross-protocol attempt: delegate to the hub attempt via
      // `traverseTranslation`. The translator shapes the request payload into
      // the hub protocol, the hub attempt issues the upstream call, then the
      // translator's event mapper rewraps the returned event stream so the
      // responses caller still sees its native frames. See Spec 6 §3.4.
      //
      // Note: `requestId` and `userAgent` are responses-specific args that are
      // forwarded through `traverseTranslation` to the hub attempt for
      // image-gen + telemetry correlation. The image-generation shortcut already
      // ran before this point, so these are safe to pass through.
      const hubProtocol = sel.targetEndpoint as HubAttemptProtocol
      const hubAttempt = (args.hubAttemptOverride ?? pickHubAttempt)(hubProtocol)
      return await traverseTranslation({
        sourcePayload: args.payload as Record<string, unknown>,
        sourceProtocol: 'responses',
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
            requestId: innerArgs.requestId,
            userAgent: innerArgs.userAgent,
          } as never)) as never
        },
        inheritedHeaders: args.inheritedHeaders ?? {},
        inheritedTelemetryCtx: args.telemetryCtx,
        auth: args.auth,
        requestId: args.requestId,
        userAgent: args.userAgent,
        signal: args.ctx.downstreamAbortSignal,
        fallbackMaxOutputTokens: (sel.binding as { upstreamMaxOutputTokens?: number }).upstreamMaxOutputTokens,
        model: sel.bareModel,
      })
    }

    const invocation: Invocation = {
      endpoint: 'responses',
      enabledFlags: new Set(),
      sourceApi: 'responses',
      payload: args.payload as Record<string, unknown>,
      headers: { ...(args.inheritedHeaders ?? {}) },
    }
    const chain: ReadonlyArray<ResponsesInterceptor> = args.interceptors ?? responsesInterceptors

    let upstreamResp: ProviderResponse | undefined

    const terminal = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
      const upstreamPayload = await sel.translator.translateRequest(invocation.payload, {
        signal: args.ctx.downstreamAbortSignal ?? new AbortController().signal,
      })
      const headers = new Headers({ 'content-type': 'application/json' })
      for (const [k, v] of Object.entries(invocation.headers)) headers.set(k, v)
      const providerReq: ProviderRequest = {
        endpoint: 'responses',
        payload: upstreamPayload,
        headers,
        sourceApi: 'openai',
        flags: { isStreaming: invocation.payload.stream === true },
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
      // Streaming branch: parse the upstream SSE body as Responses frames.
      // Non-streaming branch: buffer JSON, then synthesise frames so respond.ts
      // can run identical telemetry plumbing in both paths. Either way the
      // output is funnelled through `withUpstreamTelemetry({protocol:
      // 'responses'})` so terminal-frame classification picks up
      // `response.completed`/`response.incomplete` (success) and
      // `response.failed` (failed).
      const isClientStreaming = invocation.payload.stream === true
      const upstreamContentType = upstreamResp.headers.get('content-type') ?? ''
      const upstreamLooksJson = !isClientStreaming || upstreamContentType.includes('application/json')

      let frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>
      if (upstreamLooksJson) {
        // JSON.parse failures land in the outer try/catch below — they surface
        // as an internal-error result populated with `performance` ctx.
        const json = await readUpstreamResponsesJson(upstreamResp.body)
        frames = synthesizeResponsesFramesFromJson(json)
      } else {
        frames = parseResponsesStream(upstreamResp.body, { signal: args.ctx.downstreamAbortSignal })
      }
      const { events: decorated } = withUpstreamTelemetry(frames, {
        abortSignal: args.ctx.downstreamAbortSignal,
        protocol: 'responses',
      })
      const modelIdentity = telemetryModelIdentity(bindingForTelemetry, sel.bareModel)
      const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
      return eventResult(decorated, modelIdentity, performance)
    }

    try {
      if (chain.length === 0) return await terminal()
      // Adapter: runInterceptors expects a `ChatCompletionsStreamInterceptor`-
      // shaped chain. We don't have any responses interceptors yet, so this
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
