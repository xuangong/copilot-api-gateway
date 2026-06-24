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
 *     messages / responses) are NOT yet supported natively — Spec 3 Part 4
 *     deleted the legacy `dispatch()` bridge but native cross-protocol
 *     attempts are deferred to Spec 6. Attempt surfaces a 501 internal-error
 *     in that branch;
 *   - own an `AbortController` whose signal flows down to provider.fetch via
 *     `RequestContext.downstreamAbortSignal` AND back up to respond.ts so a
 *     client disconnect mid-SSE can cancel the upstream socket.
 *
 * Reference: copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/serve.ts
 */
import { getRuntimeLocation } from '@vnext-gateway/platform'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseChatPayload } from '../../parsers.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import type { DispatchObsCtx } from '../shared/gateway-ctx.ts'
import { runQuotaGate } from '../shared/quota-gate.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
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

  // Build the telemetry context once per request. Threaded through attempt +
  // respond so persistence helpers (`recordUsage`, `recordPerformance`) can
  // write usage rows without leaking auth/tx state into the dispatch path.
  // Falls back to '<unknown>' when an upstream caller hasn't populated
  // `apiKeyId` (e.g. tests that bypass the auth middleware), mirroring how
  // legacy DispatchObsCtx tolerates anonymous requests.
  const requestStartedAt = Date.now()
  const telemetryCtx: TelemetryRequestContext = {
    apiKeyId: args.obsCtx.apiKeyId ?? args.auth.apiKeyId ?? '<unknown>',
    userAgent: args.obsCtx.userAgent ?? null,
    requestId: args.obsCtx.requestId ?? crypto.randomUUID(),
    isStreaming: wantsStream,
    runtimeLocation: getRuntimeLocation(),
    requestStartedAt,
  }

  // Daily quota gate. Legacy dispatch ran this inside runConversationAttempt;
  // Spec 3 deletes that helper but the per-key cap is still enforced here so
  // the public `429 + rate_limit_error` envelope is preserved for SDKs.
  const quotaResp = await runQuotaGate(args.auth.apiKeyId)
  if (quotaResp) return quotaResp

  // Linked controller: aborts when the upstream client signal aborts, and is
  // also aborted by respond.ts's SSE `cancel()` if the downstream client
  // closes its read end mid-stream. Either direction triggers attempt.ts's
  // provider.fetch + parseChatCompletionsStream to unwind via the same signal.
  const controller = new AbortController()
  if (args.signal) {
    if (args.signal.aborted) controller.abort()
    else args.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const result = await chatCompletionsAttempt.generate({
    payload,
    auth: { ownerId: args.auth.userId, copilot: args.auth.copilot },
    ctx: { requestStartedAt, downstreamAbortSignal: controller.signal },
    telemetryCtx,
  })

  return respondChatCompletions(result, {
    wantsStream,
    includeUsageChunk,
    downstreamAbortController: controller,
    telemetryCtx,
  })
}
