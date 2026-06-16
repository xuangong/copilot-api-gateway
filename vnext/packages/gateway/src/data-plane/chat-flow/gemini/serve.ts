// vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
/**
 * Gemini generate/stream HTTP serve layer.
 *
 * Replaces the previous `dispatch(...)` delegation with the per-protocol
 * attempt → respond chain (Spec 3 Part 4 — gemini-side mirror of the
 * messages/responses Part 3 migration).
 *
 * Differences vs messages/serve.ts:
 *   - Gemini payloads do NOT carry a `model` field. The bare model name comes
 *     from the URL path (`/v1beta/models/<model>:generateContent`) and is
 *     passed in via `args.model` from `gemini/http.ts`.
 *   - The URL verb (`generateContent` vs `streamGenerateContent`) decides
 *     whether the CLIENT sees SSE (`forceStream === true`) or a single JSON
 *     envelope (`forceStream === false`). This flag is forwarded both to
 *     attempt.ts (so the upstream knows to negotiate a stream) and to
 *     respond.ts (which actually decides the wire shape we hand back).
 *   - Gemini has no identity target — every binding selection picks one of
 *     `messages | responses | chat_completions` as the hub target and the
 *     translator handles the reshape in a single hop. attempt.ts therefore
 *     never needs a cross-protocol fallback; the legacy `dispatch()` bridge
 *     was deleted in Spec 3 Part 4.
 *
 * Telemetry context is built once per request and threaded through both
 * attempt + respond, so persistence helpers (`recordUsage`,
 * `recordPerformance`) write usage rows without leaking auth/transaction
 * state.
 *
 * Reference: messages/serve.ts (Spec 3 Part 3 Task 3).
 */
import { getRuntimeLocation } from '@vnext/platform'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import { runQuotaGate } from '../shared/quota-gate.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { geminiAttempt } from './attempt.ts'
import { respondGemini } from './respond.ts'

export interface GeminiServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  /**
   * Bare model name extracted from the URL path. Gemini payloads do not
   * carry `model`, so the route handler peels it from
   * `/v1beta/models/<model>:<verb>` and forwards it here.
   */
  readonly model: string
  /**
   * True when the URL verb was `streamGenerateContent` (client wants SSE).
   * False when it was `generateContent` (client wants a single JSON envelope).
   * Threaded through attempt → provider (so upstream streams) AND through
   * respond.ts (which actually decides the wire shape we hand the client).
   */
  readonly forceStream: boolean
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /**
   * Optional client-side abort signal (Hono's `c.req.raw.signal`). When the
   * client disconnects we propagate the abort down to provider.fetch via a
   * controller linked here, so the upstream socket releases promptly.
   */
  readonly signal?: AbortSignal
}

export async function serveGemini(args: GeminiServeArgs): Promise<Response> {
  // Parse via the shared Zod schema. parseGeminiPayload throws a shaped Error
  // (`status: 400, body: <gemini-shape error>`); jsonErrorWrap surfaces it.
  let payload: Record<string, unknown> & { stream?: boolean }
  try {
    payload = parseGeminiPayload(args.raw) as typeof payload
  } catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return jsonErrorWrap(
      e.status ?? 400,
      e.body ?? { error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' } },
    )
  }

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
    isStreaming: args.forceStream,
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
  // provider.fetch + parseHubStream to unwind via the same signal.
  const controller = new AbortController()
  if (args.signal) {
    if (args.signal.aborted) controller.abort()
    else args.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const result = await geminiAttempt.generate({
    payload,
    model: args.model,
    forceStream: args.forceStream,
    auth: { ownerId: args.auth.userId, copilot: args.auth.copilot, apiKeyId: args.auth.apiKeyId },
    ctx: { requestStartedAt, downstreamAbortSignal: controller.signal },
    telemetryCtx,
  })

  return respondGemini(result, {
    wantsStream: args.forceStream,
    downstreamAbortController: controller,
    telemetryCtx,
  })
}
