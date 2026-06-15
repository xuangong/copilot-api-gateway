// packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts
/**
 * Chat Completions HTTP serve layer.
 *
 * Replaces the previous `dispatch(...)` delegation with the per-protocol
 * attempt → respond chain wired during Spec 2 Parts 1-3:
 *   - parse JSON payload (already pre-parsed by http.ts) into the Zod-validated
 *     `ChatPayload` shape, returning a 400 envelope on validation failure;
 *   - derive `wantsStream` + `includeUsageChunk` from the client request so
 *     `respond.ts` can choose SSE vs JSON and decide whether to keep the
 *     trailing usage chunk;
 *   - hand the parsed payload to `chatCompletionsAttempt.generate`, which runs
 *     interceptors (notably `withUsageStreamOptionsIncluded`) before the
 *     terminal upstream call. Cross-protocol targets (chat_completions →
 *     messages / responses) short-circuit through `dispatchFallback`, which
 *     re-enters the legacy `dispatch()` helper with the same `raw` body so the
 *     fallback bridge stays a single hop;
 *   - own an `AbortController` whose signal flows down to provider.fetch via
 *     `RequestContext.downstreamAbortSignal` AND back up to respond.ts so a
 *     client disconnect mid-SSE can cancel the upstream socket.
 *
 * Reference: copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/serve.ts
 */
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseChatPayload } from '../../parsers.ts'
import { dispatch } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import type { DispatchObsCtx } from '../shared/gateway-ctx.ts'
import { chatCompletionsAttempt } from './attempt.ts'
import { respondChatCompletions } from './respond.ts'

export interface ChatCompletionsServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /**
   * Optional client-side abort signal (Hono's `c.req.raw.signal`). When the
   * client disconnects we propagate the abort down to provider.fetch via a
   * controller linked here, so the upstream socket releases promptly.
   */
  readonly signal?: AbortSignal
}

export async function serveChatCompletions(args: ChatCompletionsServeArgs): Promise<Response> {
  // Parse via the shared Zod schema. parseChatPayload throws a shaped Error
  // (`status: 400, body: {error: invalid_request_error}`) — jsonErrorWrap
  // surfaces it as the legacy 400 envelope the OpenAI SDK already speaks.
  let payload: Record<string, unknown> & {
    model: string
    stream?: boolean
    stream_options?: { include_usage?: boolean }
  }
  try {
    payload = parseChatPayload(args.raw) as typeof payload
  } catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return jsonErrorWrap(
      e.status ?? 400,
      e.body ?? { error: { type: 'invalid_request_error', message: e.message } },
    )
  }

  const wantsStream = payload.stream === true
  const includeUsageChunk = payload.stream_options?.include_usage === true

  // Linked controller: aborts when the upstream client signal aborts, and is
  // also aborted by respond.ts's SSE `cancel()` if the downstream client
  // closes its read end mid-stream. Either direction triggers attempt.ts's
  // provider.fetch + parseChatCompletionsStream to unwind via the same signal.
  const controller = new AbortController()
  if (args.signal) {
    if (args.signal.aborted) controller.abort()
    else args.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // Build the raw Request shim that dispatchFallback hands back to legacy
  // `dispatch()`. The cross-protocol bridge re-uses the same parser +
  // errorWrap as our per-protocol path so the wire shape stays identical
  // when a chat-completions request targets a messages/responses binding.
  const dispatchFallback = (_raw: Request): Promise<Response> =>
    dispatch(args.raw, {
      parse: (r) => parseChatPayload(r),
      modelOf: (p) => (p as { model?: string }).model ?? '',
      sourceApi: 'chat_completions',
      fallbackMaxOutputTokens: 4096,
      errorWrap: jsonErrorWrap,
      auth: args.auth,
      obsCtx: args.obsCtx,
    })

  const result = await chatCompletionsAttempt.generate({
    payload,
    // attempt.ts only reads `raw` to hand off to dispatchFallback; we
    // synthesise a minimal Request so the bridge keeps a stable signature
    // even though dispatch() consumes `args.raw` (the parsed body) directly.
    raw: new Request('http://internal/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args.raw ?? {}),
    }),
    auth: { ownerId: args.auth.userId, copilot: args.auth.copilot },
    ctx: { requestStartedAt: Date.now(), downstreamAbortSignal: controller.signal },
    dispatchFallback,
  })

  return respondChatCompletions(result, {
    wantsStream,
    includeUsageChunk,
    downstreamAbortController: controller,
  })
}
