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
 *   - Every binding selection drives through `traverseTranslation` (Spec 6
 *     §3.4 / §5), which: (a) stamps `translatorPair` on `modelIdentity` so
 *     respond.ts can dispatch reassembly on the hub protocol; (b) forwards
 *     hub-shape frames downstream verbatim; (c) sets `translateBody` on the
 *     result so respond.ts can convert hub JSON → gemini JSON for non-streaming
 *     responses. The hub attempt (`pickHubAttempt`) owns the upstream fetch,
 *     SSE parsing, and `withUpstreamTelemetry` decoration — no bespoke stream
 *     pipeline in this file.
 *
 *   - `forceStream` semantics (set by `gemini/serve.ts` when the verb is
 *     `streamGenerateContent`) are intentionally NOT consumed here. Whether
 *     to render SSE vs JSON is a presentation concern owned by `respond.ts`
 *     (per plan Part 4 Task 2 note: "This affects respond.ts, not attempt.ts").
 *
 * Pre-binding errors (model-not-found, no-eligible-binding, no-translator)
 * deliberately omit `performance` per Spec 3 §6.2 — `respond.ts` skips the
 * perf row in that branch. Post-binding errors flow through hub attempt, which
 * carries a `performance` ctx so `recordPerformance` writes `isError=true`.
 *
 * Reference: messages/attempt.ts, responses/attempt.ts.
 */
import { runInterceptors } from '@vnext/service'
import type { Invocation, RequestContext } from '@vnext/protocols/common'
import {
  internalErrorResult,
  readUpstreamError,
  type EndpointKey,
  type ExecuteResult,
  type ModelEndpoints,
  type ProtocolFrame,
} from '@vnext/protocols/common'
import { HTTPError, type ProviderRequest, type ProviderResponse } from '@vnext/provider'
import {
  upstreamPerformanceContext,
  type AttemptBindingShape,
} from '../shared/attempt-helpers.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { enumerateBindingCandidates, type EnumerateOptions } from '../../routing/candidates.ts'
import { selectPair } from '../../dispatch/pair-selector.ts'
import { getTranslator, type PairTranslator } from '../../dispatch/translator-registry.ts'
import { traverseTranslation } from '../shared/traverse-translation.ts'
import { pickHubAttempt, type HubAttemptProtocol } from '../shared/hub-attempt-dispatch.ts'

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Gemini attempt produces hub-shape protocol frames (wrapped in
 * `ProtocolFrame<unknown>`) forwarded verbatim from the hub attempt.
 * `respond.ts` discriminates on `modelIdentity.translatorPair` to decide
 * whether to apply `translateEvents` (streaming) or `translateBody`
 * (non-streaming), matching the pattern in messages/responses respond.ts.
 */
export type GeminiAttemptResult = ExecuteResult<ProtocolFrame<unknown>>

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
   * Forwarded to the hub attempt as part of the invocation context so the
   * upstream negotiates SSE when streaming is wanted; whether to actually
   * render SSE vs JSON is owned by respond.ts.
   */
  readonly forceStream: boolean
  readonly auth: GeminiAttemptAuth
  readonly ctx: RequestContext
  readonly telemetryCtx: TelemetryRequestContext
  /** Optional binding selector (testable). */
  readonly selectBinding?: SelectGeminiBinding
  /** Overridable interceptor chain; defaults to an empty chain (terminal-only). */
  readonly interceptors?: ReadonlyArray<GeminiInterceptor>
  readonly inheritedHeaders?: Record<string, string>
  readonly snapshotMode?: 'none'
  /**
   * Test seam for cross-protocol dispatch. When the resolved binding routes to
   * a hub target, the attempt looks up the hub attempt via this override (if
   * provided) or {@link pickHubAttempt} otherwise. Production code never sets
   * this; tests inject a fake hub attempt to keep the cross-protocol contract
   * independent of the real messages/responses/chat_completions attempt
   * implementations.
   */
  readonly hubAttemptOverride?: (p: HubAttemptProtocol) => { generate: (a: never) => Promise<never> }
}

// Stream-interceptor stub mirrors messages/responses — Spec 3 keeps the
// minimum scope. No gemini-specific interceptors are registered yet.
export type GeminiInterceptor = (
  inv: Invocation,
  ctx: RequestContext,
  next: (inv: Invocation, ctx: RequestContext) => Promise<ExecuteResult<ProtocolFrame<unknown>>>,
) => Promise<ExecuteResult<ProtocolFrame<unknown>>>

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

// ─── Main attempt ─────────────────────────────────────────────────────────

export const geminiAttempt = {
  generate: async (args: GeminiAttemptArgs): Promise<GeminiAttemptResult> => {
    const selectFn = args.selectBinding ?? defaultSelectBinding
    const sel = await selectFn({ model: args.model, auth: args.auth })

    if (sel.kind === 'model-not-found') return internalErrorResult(404, new Error(`model not found: ${sel.bareModel}`))
    if (sel.kind === 'no-eligible-binding') return internalErrorResult(404, new Error(`no eligible binding for: ${sel.bareModel}`))
    if (sel.kind === 'no-translator') return internalErrorResult(500, new Error(`no translator for gemini → ${sel.targetEndpoint}`))

    // Gemini has no identity target — selectPair('gemini', …) never returns
    // 'gemini' — so every successful selection is a cross-protocol attempt.
    // Delegate to `traverseTranslation` so telemetry (`translatorPair`) and
    // `translateBody` propagation match messages/responses (Spec 6 §3.4 / §5).
    const hubProtocol = sel.targetEndpoint as HubAttemptProtocol
    const hubAttempt = (args.hubAttemptOverride ?? pickHubAttempt)(hubProtocol)

    const invocation: Invocation = {
      endpoint: sel.targetEndpoint,
      enabledFlags: new Set(),
      sourceApi: 'gemini',
      payload: args.payload as Record<string, unknown>,
      headers: {},
    }
    const chain: ReadonlyArray<GeminiInterceptor> = args.interceptors ?? []

    const bindingForTelemetry = sel.binding as unknown as AttemptBindingShape

    const terminal = async (): Promise<GeminiAttemptResult> => {
      return await traverseTranslation({
        sourcePayload: args.payload as Record<string, unknown>,
        sourceProtocol: 'gemini',
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
      }) as GeminiAttemptResult
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
      const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
      // HTTPError is the legacy provider contract for upstream non-2xx; the
      // hub attempt's ProviderResponse-based branch above already covers the
      // new contract, but we keep this guard for providers that still throw.
      if (err instanceof HTTPError) return await readUpstreamError(err.response, performance)
      return internalErrorResult(502, err instanceof Error ? err : new Error(String(err)), performance)
    }
  },
}
