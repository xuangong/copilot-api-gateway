// vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts
/**
 * Anthropic Messages attempt orchestrator.
 *
 * Mirrors `chat-completions/attempt.ts` (Spec 2 Part 3 Task 1) but specialised
 * for the Messages source:
 *   - source preference is `messages → responses → chat_completions`
 *     (per `pair-selector.ts`)
 *   - identity target (`messages → messages`) parses the upstream SSE body via
 *     `parseMessagesStream`, decorates with `withUpstreamTelemetry({protocol:
 *     'messages'})`, and emits an `EventResult<ProtocolFrame<MessagesStreamEvent>>`
 *   - cross-protocol targets (`messages → responses` / `messages →
 *     chat_completions`) short-circuit through `dispatchFallback` to the legacy
 *     `dispatch()` helper; the wrapped `Response` is surfaced as a
 *     `bridged-response` sentinel that `respond.ts` hands back unchanged.
 *
 * Pre-binding errors (model-not-found, no-eligible-binding, no-translator)
 * deliberately omit `performance` per Spec 3 §6.2 — `respond.ts` skips the
 * perf row in that branch. Post-binding errors (upstream 4xx/5xx, terminal
 * decode failures) carry a `performance` ctx so `recordPerformance` writes
 * `isError=true`.
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
import {
  parseMessagesStream,
  type MessagesStreamEvent,
} from '@vnext/protocols/messages'
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

// ─── Public types ─────────────────────────────────────────────────────────

export type MessagesAttemptResult =
  | ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
  | { readonly kind: 'bridged-response'; readonly response: Response }

export interface MessagesAttemptAuth {
  readonly ownerId?: string
  readonly pin?: string
  readonly copilot?: EnumerateOptions['copilot']
}

/**
 * NonStreamPayload is the messages-specific JSON envelope produced when the
 * client did NOT request `stream: true`. The pass-through path returns the
 * upstream body verbatim through `translator.translateBody` (identity for
 * messages → messages).
 */
export interface MessagesAttemptArgs {
  readonly payload: Record<string, unknown> & { model: string; stream?: boolean }
  readonly raw: Request
  readonly auth: MessagesAttemptAuth
  readonly ctx: RequestContext
  readonly telemetryCtx: TelemetryRequestContext
  /**
   * Optional binding selector (testable). Defaults to inline enumeration via
   * `enumerateBindingCandidates({pickTarget: selectPair('messages', e)})`.
   */
  readonly selectBinding?: SelectMessagesBinding
  /** Legacy bridge for cross-protocol targets; called with the raw `Request`. */
  readonly dispatchFallback: (raw: Request) => Promise<Response>
  /** Overridable interceptor chain; defaults to an empty chain (terminal-only). */
  readonly interceptors?: ReadonlyArray<MessagesInterceptor>
}

// We don't expose a stream-interceptor for messages yet (Spec 3 keeps the
// minimum scope). Define a placeholder that mirrors the chat-completions shape
// so future Spec-N work can plug in.
export type MessagesInterceptor = (
  inv: Invocation,
  ctx: RequestContext,
  next: (inv: Invocation, ctx: RequestContext) => Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>,
) => Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>

// ─── Binding selection ───────────────────────────────────────────────────

export type SelectMessagesBindingResult =
  | { kind: 'ok'; binding: AttemptBindingShape & { readonly provider: { readonly fetch: (req: ProviderRequest) => Promise<ProviderResponse>; readonly getPricingForModelKey: (k: string) => unknown | null } }; targetEndpoint: EndpointKey; translator: PairTranslator; bareModel: string }
  | { kind: 'model-not-found'; bareModel: string }
  | { kind: 'no-eligible-binding'; bareModel: string }
  | { kind: 'no-translator'; bareModel: string; targetEndpoint: EndpointKey }

export type SelectMessagesBinding = (
  args: { model: string; auth: MessagesAttemptAuth },
) => Promise<SelectMessagesBindingResult>

const pickTargetForMessages = (endpoints: ModelEndpoints): EndpointKey | null =>
  selectPair('messages', endpoints)

const defaultSelectBinding: SelectMessagesBinding = async ({ model, auth }) => {
  const { candidates, sawModel, bareModel } = await enumerateBindingCandidates({
    model,
    pickTarget: pickTargetForMessages,
    opts: {
      ownerId: auth.ownerId,
      copilot: auth.copilot,
      pin: auth.pin,
    },
  })
  if (!sawModel) return { kind: 'model-not-found', bareModel }
  const first = candidates[0]
  if (!first) return { kind: 'no-eligible-binding', bareModel }
  const translator = getTranslator('messages', first.targetEndpoint)
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

interface MessagesNonStreamEnvelope {
  id?: string
  type?: string
  role?: string
  content?: unknown
  model?: string
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
}

/**
 * Buffer the upstream body and decode as a Messages JSON envelope. Surfaces a
 * `JSON.parse` error to the caller so attempt.ts's outer try/catch can map it
 * to an internal-error result populated with `performance` ctx (Test 3 of the
 * acceptance battery).
 *
 * Exported for cross-protocol reuse by `gemini/attempt.ts` when its hub target
 * is `messages`: gemini-side enumerates the same hub bindings, so when the
 * upstream returns JSON instead of SSE we run identical buffering + synth.
 */
export async function readUpstreamMessagesJson(
  body: ReadableStream<Uint8Array>,
): Promise<MessagesNonStreamEnvelope> {
  const buf = await new Response(body).text()
  return JSON.parse(buf) as MessagesNonStreamEnvelope
}

/**
 * Synthesise the SSE event sequence a Messages-native client would have seen
 * if upstream had streamed instead of returning JSON. Lets respond.ts run a
 * single `consumeWithState` pass + `withUpstreamTelemetry` over both branches,
 * so usage extraction + modelKey correction work identically.
 *
 * Sequence: `message_start` (model + initial usage) → one `content_block_*`
 * trio per top-level content block → `message_delta` (final usage +
 * stop_reason) → `message_stop`. Order matches the live SSE feed observed in
 * `messages.e2e.test.ts:makeUpstreamSSE`.
 *
 * Exported for cross-protocol reuse by `gemini/attempt.ts` (see above).
 */
export async function* synthesizeMessagesFramesFromJson(
  body: MessagesNonStreamEnvelope,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  const id = body.id ?? `msg_${Date.now()}`
  const model = body.model ?? ''
  const usage = body.usage ?? { input_tokens: 0, output_tokens: 0 }
  yield {
    type: 'event',
    event: {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
        },
      },
    } as MessagesStreamEvent,
  }
  const blocks = Array.isArray(body.content) ? body.content : []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as { type?: string; text?: string }
    yield {
      type: 'event',
      event: {
        type: 'content_block_start',
        index: i,
        content_block: { type: block.type ?? 'text', text: block.text ?? '' } as never,
      } as MessagesStreamEvent,
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      yield {
        type: 'event',
        event: {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'text_delta', text: block.text },
        } as MessagesStreamEvent,
      }
    }
    yield {
      type: 'event',
      event: { type: 'content_block_stop', index: i } as MessagesStreamEvent,
    }
  }
  yield {
    type: 'event',
    event: {
      type: 'message_delta',
      delta: {
        stop_reason: (body.stop_reason ?? 'end_turn') as never,
        stop_sequence: body.stop_sequence ?? null,
      },
      usage: { output_tokens: usage.output_tokens ?? 0 },
    } as MessagesStreamEvent,
  }
  yield {
    type: 'event',
    event: { type: 'message_stop' } as MessagesStreamEvent,
  }
}

// ─── Main attempt ─────────────────────────────────────────────────────────

export const messagesAttempt = {
  generate: async (args: MessagesAttemptArgs): Promise<MessagesAttemptResult> => {
    const selectFn = args.selectBinding ?? defaultSelectBinding
    const sel = await selectFn({ model: args.payload.model, auth: args.auth })

    if (sel.kind === 'model-not-found') return internalErrorResult(404, new Error(`model not found: ${sel.bareModel}`))
    if (sel.kind === 'no-eligible-binding') return internalErrorResult(404, new Error(`no eligible binding for: ${sel.bareModel}`))
    if (sel.kind === 'no-translator') return internalErrorResult(500, new Error(`no translator for messages → ${sel.targetEndpoint}`))

    if (sel.targetEndpoint !== 'messages') {
      // FIXME(spec-6): native cross-protocol attempts. For now bridge to legacy
      // dispatch() to keep messages → responses / messages → chat_completions
      // working unchanged.
      return { kind: 'bridged-response', response: await args.dispatchFallback(args.raw) }
    }

    const invocation: Invocation = {
      endpoint: 'messages',
      enabledFlags: new Set(),
      sourceApi: 'messages',
      payload: args.payload as Record<string, unknown>,
      headers: {},
    }
    const chain: ReadonlyArray<MessagesInterceptor> = args.interceptors ?? []

    let upstreamResp: ProviderResponse | undefined

    const terminal = async (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
      const upstreamPayload = await sel.translator.translateRequest(invocation.payload, {
        signal: args.ctx.downstreamAbortSignal ?? new AbortController().signal,
      })
      const headers = new Headers({ 'content-type': 'application/json' })
      for (const [k, v] of Object.entries(invocation.headers)) headers.set(k, v)
      const providerReq: ProviderRequest = {
        endpoint: 'messages',
        payload: upstreamPayload,
        headers,
        sourceApi: 'anthropic',
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
      // Streaming branch: parse the upstream SSE body as messages frames.
      // Non-streaming branch: buffer JSON, then synthesise frames so respond.ts
      // can run identical telemetry plumbing in both paths. Either way the
      // output is funnelled through `withUpstreamTelemetry({protocol: 'messages'})`
      // so terminal-frame classification picks up `message_stop` (success)
      // / `error` (failed).
      const isClientStreaming = invocation.payload.stream === true
      const upstreamContentType = upstreamResp.headers.get('content-type') ?? ''
      const upstreamLooksJson = !isClientStreaming || upstreamContentType.includes('application/json')

      let frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>
      if (upstreamLooksJson) {
        // JSON.parse failures land in the outer try/catch below — they surface
        // as an internal-error result populated with `performance` ctx.
        const json = await readUpstreamMessagesJson(upstreamResp.body)
        frames = synthesizeMessagesFramesFromJson(json)
      } else {
        frames = parseMessagesStream(upstreamResp.body, { signal: args.ctx.downstreamAbortSignal })
      }
      const { events: decorated } = withUpstreamTelemetry(frames, {
        abortSignal: args.ctx.downstreamAbortSignal,
        protocol: 'messages',
      })
      const modelIdentity = telemetryModelIdentity(bindingForTelemetry, sel.bareModel)
      const performance = upstreamPerformanceContext(args.telemetryCtx, bindingForTelemetry, sel.bareModel)
      return eventResult(decorated, modelIdentity, performance)
    }

    try {
      // Empty interceptor chain falls straight through to terminal. The
      // signature is kept aligned with chat-completions so future stream
      // interceptors plug in without re-shuffling attempt.ts.
      if (chain.length === 0) return await terminal()
      // Adapter: runInterceptors expects a `ChatCompletionsStreamInterceptor`-
      // shaped chain. We don't have any messages interceptors yet, so this
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
