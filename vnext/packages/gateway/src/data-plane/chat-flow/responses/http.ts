import { ClientDisconnect } from "../shared/client-disconnect"
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
 *   1. Open the per-request dump seam (buffers the body once so parser and
 *      dump accumulator share the exact bytes).
 *   2. Parse raw body; reject malformed JSON with the legacy 400 envelope
 *      (routed through the dump finalize seam so error rows land too).
 *   3. Hand off to `serveResponses`, which gates reusable completion on
 *      snapshot persistence before the kit finalizes the request dump.
 */
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveResponses } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'
import { openRequestDump, parseJsonBody } from '../shared/dump-open.ts'

export async function responsesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  return responsesHandlerCore(c, undefined)
}

/**
 * `POST /v1/responses/compact` — synchronous compact wire.
 *
 * Stamps `action: 'compact'` onto the invocation so the Responses
 * compact-shim engages (see `interceptors/with-responses-compact-shim.ts`
 * for engagement + payload rewrite). The wire is always non-streaming: the
 * shim reassembles the summarization turn into a single
 * `response.compaction` envelope and `respond.ts` renders it as JSON.
 */
export async function responsesCompactHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  return responsesHandlerCore(c, 'compact')
}

async function responsesHandlerCore(
  c: Context<{ Bindings: Env }>,
  action: 'generate' | 'compact' | undefined,
): Promise<Response> {
  const auth = readAuth(c)
  const { requestBody, dump } = await openRequestDump(c, auth, c.req.method)
  let raw: unknown
  try { raw = parseJsonBody(requestBody.bytes) } catch { return dump ? dump.finalize(invalidJsonResponse()) : invalidJsonResponse() }
  const obsCtx = readObsCtx(c, auth)
  const disconnect = new ClientDisconnect(c.req.raw.signal)
  const { response } = await serveResponses({
    raw,
    retainInputHistory: false,
    auth,
    obsCtx,
    signal: disconnect.controller.signal,
    requestId: obsCtx.requestId,
    userAgent: obsCtx.userAgent,
    dump,
    action,
  })
  return disconnect.wrap(response)
}
