// vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts
/**
 * Chat Completions attempt orchestrator.
 *
 * Builds an `Invocation`, runs `chatCompletionsInterceptors`, and (in the
 * terminal handler) issues the upstream call via the resolved provider. On
 * a cross-protocol target (e.g. `chat_completions → messages`) we short-
 * circuit to the legacy `dispatch()` helper via `dispatchFallback`; the
 * returned `Response` is surfaced as a `bridged-response` sentinel that
 * `respond.ts` (Part 3 Task 2) hands back to the client unchanged.
 *
 * Reference: copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/attempt.ts
 */
import { runInterceptors, type Invocation, type RequestContext, type ChatCompletionsStreamInterceptor } from '@vnext/interceptor'
import { eventResult, internalErrorResult, readUpstreamError, type ExecuteResult, type ProtocolFrame } from '@vnext/protocols/common'
import { parseChatCompletionsStream, type ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import type { ProviderRequest, ProviderResponse } from '@vnext/provider'
import { withUpstreamTelemetry } from '../shared/upstream-telemetry'
import { selectBindingForChatCompletions, type SelectBindingAuth, type SelectBindingResult } from '../shared/select-binding'
import { chatCompletionsInterceptors } from './interceptors'

export type ChatCompletionsAttemptResult =
  | ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
  | { readonly kind: 'bridged-response'; readonly response: Response }

// Reuses the routing helper's auth shape so we never lose detail when the
// terminal hands the same value back to `selectBindingForChatCompletions`.
export type ChatCompletionsAttemptAuth = SelectBindingAuth

export interface ChatCompletionsAttemptArgs {
  readonly payload: Record<string, unknown> & { model: string; stream?: boolean }
  readonly raw: Request
  readonly auth: ChatCompletionsAttemptAuth
  readonly ctx: RequestContext
  /** Injected for tests; defaults to {@link selectBindingForChatCompletions}. */
  readonly selectBinding?: (args: { model: string; auth: ChatCompletionsAttemptAuth }) => Promise<SelectBindingResult>
  /** Legacy bridge for cross-protocol targets; called with the raw `Request`. */
  readonly dispatchFallback: (raw: Request) => Promise<Response>
  /** Overridable interceptor chain (defaults to the production registry). */
  readonly interceptors?: ReadonlyArray<ChatCompletionsStreamInterceptor>
}

// Minimal binding shape we actually depend on. Keeps tests free of the full
// ProviderBinding ceremony while staying type-safe inside this module.
type AttemptBinding = { readonly provider: { readonly fetch: (req: ProviderRequest) => Promise<ProviderResponse> } }

export const chatCompletionsAttempt = {
  generate: async (args: ChatCompletionsAttemptArgs): Promise<ChatCompletionsAttemptResult> => {
    const selectFn = args.selectBinding ?? ((a) => selectBindingForChatCompletions(a))
    const sel = await selectFn({ model: args.payload.model, auth: args.auth })

    if (sel.kind === 'model-not-found') return internalErrorResult(404, new Error(`model not found: ${sel.bareModel}`))
    if (sel.kind === 'no-eligible-binding') return internalErrorResult(404, new Error(`no eligible binding for: ${sel.bareModel}`))
    if (sel.kind === 'no-translator') return internalErrorResult(500, new Error(`no translator for chat_completions → ${sel.targetEndpoint}`))

    if (sel.targetEndpoint !== 'chat_completions') {
      // FIXME(spec-6): native cross-protocol attempts; for now bridge to legacy dispatch().
      return { kind: 'bridged-response', response: await args.dispatchFallback(args.raw) }
    }

    const invocation: Invocation = {
      endpoint: 'chat_completions',
      enabledFlags: new Set(),
      sourceApi: 'chat_completions',
      payload: args.payload as Record<string, unknown>,
      headers: {},
    }
    const chain = args.interceptors ?? chatCompletionsInterceptors

    // Lifted so the outer catch can cancel the upstream body if a wrapping
    // interceptor throws AFTER the terminal opened it. Without this, the
    // upstream stream lingers until GC.
    let upstreamResp: ProviderResponse | undefined

    const terminal = async (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
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
      upstreamResp = await binding.provider.fetch(providerReq)
      if (upstreamResp.status < 200 || upstreamResp.status >= 300) {
        // Wrap the ProviderResponse shape into a Response so readUpstreamError
        // can buffer body + headers using the standard helper.
        const errResp = new Response(upstreamResp.body, { status: upstreamResp.status, headers: upstreamResp.headers })
        return await readUpstreamError(errResp)
      }
      if (!upstreamResp.body) {
        return internalErrorResult(502, new Error('upstream returned empty body'))
      }
      const stream = parseChatCompletionsStream(upstreamResp.body, { signal: args.ctx.downstreamAbortSignal })
      // Telemetry recorder wiring stays minimal in spec2; real wiring lands in Part 4.
      const decorated = withUpstreamTelemetry(
        stream,
        { abortSignal: args.ctx.downstreamAbortSignal },
        { recordFirstByteLatency: () => {}, recordSuccess: () => {}, recordFailure: () => {} },
        { protocol: 'chat_completions' },
      )
      return eventResult(decorated)
    }

    try {
      return await runInterceptors(invocation, args.ctx, chain, terminal)
    } catch (err) {
      // If terminal opened an upstream body but a wrapping interceptor threw
      // before anyone could consume it, cancel to release the connection.
      // Swallow cancel errors (body may be locked or already cancelled).
      if (upstreamResp?.body) void upstreamResp.body.cancel().catch(() => {})
      return internalErrorResult(502, err instanceof Error ? err : new Error(String(err)))
    }
  },
}
