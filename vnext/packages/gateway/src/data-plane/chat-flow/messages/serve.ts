// vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts
/**
 * Anthropic Messages HTTP serve layer.
 *
 * Replaces the previous `dispatch(...)` delegation with the per-protocol
 * attempt → respond chain (Spec 3 Part 3 — messages-side mirror of chat
 * completions Part 2 migration). Steps:
 *   - validate the JSON body via `parseMessagesPayload`, surfacing the legacy
 *     400 envelope (`{type: 'error', error: {type: 'invalid_request_error',
 *     message}}`) on failure;
 *   - derive `wantsStream = payload.stream === true` so respond.ts knows
 *     whether to stream SSE or render a JSON envelope;
 *   - hand off to `messagesAttempt.generate` for binding selection +
 *     translator + provider.fetch. Cross-protocol targets (`messages →
 *     responses` / `messages → chat_completions`) short-circuit through
 *     `dispatchFallback`, which re-enters legacy `dispatch()` with the same
 *     `raw` body so the bridge stays a single hop;
 *   - thread an `AbortController` linked to the inbound `args.signal`
 *     (Hono's `c.req.raw.signal`) so a client disconnect mid-SSE cancels
 *     `provider.fetch` + `parseMessagesStream` via the same downstream
 *     signal. respond.ts's SSE `cancel()` aborts the same controller for the
 *     reverse direction.
 *
 * Telemetry context is built once per request and threaded through both
 * attempt + respond, so persistence helpers (`recordUsage`,
 * `recordPerformance`) write usage rows without leaking auth/transaction
 * state into the legacy dispatch path.
 *
 * Reference: chat-completions/serve.ts (Spec 2 Part 3 Task 1).
 */
import { getRuntimeLocation } from '@vnext/platform'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesPayload } from '../../parsers.ts'
import { dispatch } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import { runQuotaGate } from '../shared/quota-gate.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { messagesAttempt } from './attempt.ts'
import { respondMessages } from './respond.ts'

export interface MessagesServeArgs {
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

export async function serveMessages(args: MessagesServeArgs): Promise<Response> {
  // Parse via the shared Zod schema. parseMessagesPayload throws a shaped
  // Error (`status: 400, body: {type: 'error', error: {type:
  // 'invalid_request_error', message}}`) — jsonErrorWrap surfaces it as the
  // Anthropic-shaped 400 envelope clients already speak.
  let payload: Record<string, unknown> & { model: string; stream?: boolean }
  try {
    payload = parseMessagesPayload(args.raw) as typeof payload
  } catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return jsonErrorWrap(
      e.status ?? 400,
      e.body ?? {
        type: 'error',
        error: { type: 'invalid_request_error', message: e.message },
      },
    )
  }

  const wantsStream = payload.stream === true

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
  // provider.fetch + parseMessagesStream to unwind via the same signal.
  const controller = new AbortController()
  if (args.signal) {
    if (args.signal.aborted) controller.abort()
    else args.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // Build the raw Request shim that dispatchFallback hands back to legacy
  // `dispatch()`. The cross-protocol bridge re-uses the same parser +
  // errorWrap as our per-protocol path so the wire shape stays identical
  // when a messages request targets a chat_completions/responses binding.
  const dispatchFallback = (_raw: Request): Promise<Response> =>
    dispatch(args.raw, {
      parse: (r) => parseMessagesPayload(r),
      modelOf: (p) => (p as { model?: string }).model ?? '',
      sourceApi: 'messages',
      errorWrap: jsonErrorWrap,
      auth: args.auth,
      obsCtx: args.obsCtx,
    })

  const result = await messagesAttempt.generate({
    payload,
    // attempt.ts only reads `raw` to hand off to dispatchFallback; we
    // synthesise a minimal Request so the bridge keeps a stable signature
    // even though dispatch() consumes `args.raw` (the parsed body) directly.
    raw: new Request('http://internal/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args.raw ?? {}),
    }),
    auth: { ownerId: args.auth.userId, copilot: args.auth.copilot },
    ctx: { requestStartedAt, downstreamAbortSignal: controller.signal },
    telemetryCtx,
    dispatchFallback,
  })

  return respondMessages(result, {
    wantsStream,
    downstreamAbortController: controller,
    telemetryCtx,
  })
}
