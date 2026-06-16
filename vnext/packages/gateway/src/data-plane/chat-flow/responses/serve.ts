// vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts
/**
 * /v1/responses HTTP serve layer.
 *
 * Replaces the previous `dispatch(...)` delegation with the per-protocol
 * attempt → respond chain (Spec 3 Part 3 — responses-side mirror of the
 * messages migration). Steps:
 *   - validate the JSON body via `parseResponsesPayload`, surfacing the
 *     legacy 400 envelope on failure;
 *   - expand `previous_response_id` against the responses store BEFORE
 *     binding selection so the upstream payload includes the merged input
 *     history. We capture the resulting input array as `mergedInputItems`
 *     and return it alongside the final Response — http.ts threads it into
 *     the snapshot sidecar so the post-turn snapshot persists with the
 *     full input history;
 *   - derive `wantsStream = payload.stream === true` so respond.ts knows
 *     whether to stream SSE or render a JSON envelope;
 *   - hand off to `responsesAttempt.generate` for image-generation
 *     short-circuit / binding selection / translator / provider.fetch.
 *     Cross-protocol targets (`responses → messages` / `responses →
 *     chat_completions`) are NOT yet supported natively — Spec 3 Part 4
 *     deleted the legacy `dispatch()` bridge but native cross-protocol
 *     attempts are deferred to Spec 6. Attempt surfaces a 501 internal-error
 *     in that branch;
 *   - thread an `AbortController` linked to the inbound `args.signal`
 *     (Hono's `c.req.raw.signal`) so a client disconnect mid-SSE cancels
 *     `provider.fetch` + `parseResponsesStream` via the same downstream
 *     signal. respond.ts's SSE `cancel()` aborts the same controller for
 *     the reverse direction.
 *
 * Telemetry context is built once per request and threaded through both
 * attempt + respond, so persistence helpers (`recordUsage`,
 * `recordPerformance`) write usage rows without leaking auth/transaction
 * state into the legacy dispatch path.
 *
 * Reference: messages/serve.ts.
 */
import { getRuntimeLocation } from '@vnext/platform'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseResponsesPayload } from '../../parsers.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import { runQuotaGate } from '../shared/quota-gate.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { expandPreviousResponseId } from '../../dispatch/responses-store-bridge.ts'
import { PreviousResponseNotFoundError } from '../../dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from '../../errors/repackage.ts'
import { getResponsesStore } from '../../../shared/runtime/responses-store.ts'
import { responsesAttempt } from './attempt.ts'
import { respondResponses } from './respond.ts'

export interface ResponsesServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /** Optional client-side abort signal (Hono's `c.req.raw.signal`). */
  readonly signal?: AbortSignal
  /** Optional request id passthrough so attempt.ts can stamp it on shortcut upstream calls. */
  readonly requestId?: string
  /** Optional User-Agent passthrough so attempt.ts can echo it into shortcut upstream calls. */
  readonly userAgent?: string
}

export interface ResponsesServeResult {
  readonly response: Response
  readonly mergedInputItems: unknown[]
}

export async function serveResponses(args: ResponsesServeArgs): Promise<ResponsesServeResult> {
  // Parse via the shared Zod schema. parseResponsesPayload throws a shaped
  // Error (`status: 400, body: {error: {type, message}}`) — jsonErrorWrap
  // surfaces it as the OpenAI-shaped 400 envelope clients already speak.
  let payload: Record<string, unknown> & { model: string; stream?: boolean; input?: unknown; tools?: unknown }
  try {
    payload = parseResponsesPayload(args.raw) as typeof payload
  } catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return {
      response: jsonErrorWrap(
        e.status ?? 400,
        e.body ?? {
          error: { type: 'invalid_request_error', message: e.message },
        },
      ),
      mergedInputItems: [],
    }
  }

  // Expand `previous_response_id` BEFORE binding selection. Mutates `payload.input`
  // in place (legacy contract from `expandPreviousResponseId`); we then read
  // the expanded array off `payload.input` so the snapshot sidecar can persist
  // the full input history for the next turn.
  let mergedInputItems: unknown[] = []
  try {
    const store = getResponsesStore()
    await expandPreviousResponseId(
      payload as { previous_response_id?: string | null; input?: unknown },
      store,
      args.auth.apiKeyId ?? null,
    )
    const expanded = (payload as { input?: unknown }).input
    mergedInputItems = Array.isArray(expanded) ? (expanded as unknown[]) : []
  } catch (err) {
    // Treat expansion failures as a 400 (the typical cause is a bad
    // previous_response_id pointing at a missing snapshot). Mirrors the
    // legacy `dispatch()` postParse behaviour where postParse errors bubble
    // through the standard errorWrap.
    //
    // PreviousResponseNotFoundError carries only `status: 400` (no `body`),
    // so we must explicitly delegate to renderPreviousResponseNotFound to
    // preserve the OpenAI-verbatim envelope (`code: 'previous_response_not_found'`,
    // `param: 'previous_response_id'`) — otherwise the generic fallback below
    // strips those fields and clients can't recover programmatically.
    if (err instanceof PreviousResponseNotFoundError) {
      return {
        response: renderPreviousResponseNotFound(err),
        mergedInputItems: [],
      }
    }
    const e = err as Error & { status?: number; body?: unknown }
    return {
      response: jsonErrorWrap(
        e.status ?? 400,
        e.body ?? {
          error: { type: 'invalid_request_error', message: e.message },
        },
      ),
      mergedInputItems: [],
    }
  }

  const wantsStream = payload.stream === true

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
  if (quotaResp) return { response: quotaResp, mergedInputItems: [] }

  // Linked controller — same plumbing as messages/serve.ts.
  const controller = new AbortController()
  if (args.signal) {
    if (args.signal.aborted) controller.abort()
    else args.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const result = await responsesAttempt.generate({
    payload,
    auth: {
      ownerId: args.auth.userId,
      copilot: args.auth.copilot,
      apiKeyId: args.auth.apiKeyId,
    },
    ctx: { requestStartedAt, downstreamAbortSignal: controller.signal },
    telemetryCtx,
    requestId: args.requestId,
    userAgent: args.userAgent,
  })

  const response = await respondResponses(result, {
    wantsStream,
    downstreamAbortController: controller,
    telemetryCtx,
  })
  return { response, mergedInputItems }
}
