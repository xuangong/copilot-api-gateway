// vnext/packages/gateway/src/data-plane/chat-flow/responses/http.ts
/**
 * /v1/responses HTTP entry point.
 *
 * Spec 3 Part 3 Task 7: simplified handler now that the image-generation
 * server-tool short-circuit has moved into `responses/attempt.ts` (the
 * new orchestrator surfaces it as an `__interceptorReplaced` LlmEventResult
 * with backend image-model `modelKey` on `finalMetadata`).
 *
 * The flow:
 *   1. Parse raw body; reject malformed JSON with the legacy 400 envelope.
 *   2. Hand off to `serveResponses` (attempt → respond chain). It returns a
 *      fully-rendered `Response` plus the `mergedInputItems` array we need
 *      for the snapshot sidecar to persist the post-turn input history.
 *   3. For 2xx Responses (SSE or JSON), tee/clone the body via
 *      `attachStreamSidecar` / `attachNonStreamSidecar` so the post-turn
 *      snapshot lands without contaminating the new telemetry channel.
 *      The sidecar must NOT touch `finalMetadata` or
 *      `__interceptorReplaced` — those belong to the telemetry channel
 *      owned by `respond.ts`.
 */
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveResponses } from './serve.ts'
import { attachStreamSidecar, attachNonStreamSidecar } from './snapshot-sidecar.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function responsesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  const obsCtx = readObsCtx(c, auth)
  const { response, mergedInputItems } = await serveResponses({
    raw,
    auth,
    obsCtx,
    signal: c.req.raw.signal,
    requestId: obsCtx.requestId,
    userAgent: obsCtx.userAgent,
  })
  if (response.status !== 200) return response
  const ct = response.headers.get('content-type') ?? ''
  const fallbackModel = (raw as { model?: string }).model ?? ''
  const apiKeyId = auth.apiKeyId ?? null
  const requestId = obsCtx.requestId ?? null
  if (ct.includes('text/event-stream') && response.body) {
    return attachStreamSidecar({ c, response, fallbackModel, apiKeyId, requestId, mergedInputItems })
  }
  if (ct.includes('application/json')) {
    return attachNonStreamSidecar({ c, response, fallbackModel, apiKeyId, requestId, mergedInputItems })
  }
  return response
}
