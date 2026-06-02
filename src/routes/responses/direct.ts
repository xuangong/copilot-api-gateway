import { detectClient } from "~/lib/client-detect"
import { resolveBinding, effectiveFlags, pinFromPayload } from "~/lib/binding-resolver"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import { withConnectionMismatchRetry } from "~/services/copilot/connection-mismatch"
import { withCyberPolicyRetry } from "~/services/copilot/cyber-policy-retry"
import {
  addWebSearchHeaders,
  recordWebSearchUsage,
} from "~/services/web-search"
import { createResponsesInterceptorStream, type ResponsesPayload } from "~/transforms"

import {
  countNativeWebSearchFromOutput,
  countNativeWebSearchFromSSE,
  type RouteContext,
} from "./utils"

type RespJson = {
  usage?: { input_tokens?: number; output_tokens?: number }
  output?: Array<{ type?: string; status?: string }>
}

/**
 * Direct /v1/responses passthrough for gpt-5.x — streaming branch.
 * `directWebSearchEnabled` toggles native web_search metering.
 */
export async function handleDirectStreaming(
  ctx: RouteContext,
  payload: ResponsesPayload,
  directWebSearchEnabled: boolean,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const model = payload.model

  const upstreamTimer = startTimer()
  const binding = await resolveBinding(state, ctx.userId, model, "responses", pinFromPayload(payload as unknown as Record<string, unknown>))
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `No responses upstream available for model: ${model}. Run GET /v1/models for available ids.` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream
  const response = await withCyberPolicyRetry(
    effectiveFlags(state, binding),
    () => withConnectionMismatchRetry(
      payload as unknown as Record<string, unknown>,
      (p) => provider.fetch(
        "responses",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "responses" },
      ),
    ),
  )
  const upstreamMs = upstreamTimer()

  // Inject SSE comment heartbeats during long thinking gaps so the downstream
  // connection never goes 60s without a byte (which would trip client SDK
  // read-timeouts or intermediate proxies).
  let responseBody = response.body
  if (apiKeyId && responseBody) {
    const [usageBranch, forwardBranch] = responseBody.tee()
    consumeStreamForUsage(usageBranch, apiKeyId, model, client, upstreamId)
    responseBody = forwardBranch
  }
  const heartbeated = wrapOpenAIHeartbeat(responseBody)
  // After whole-frame boundaries are guaranteed by the heartbeat wrapper,
  // run the Responses SSE interceptor chain: synchronize output-item IDs and
  // abort on tool-arg whitespace overflow.
  const intercepted = heartbeated
    ? heartbeated.pipeThrough(createResponsesInterceptorStream())
    : null
  const directHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  }

  // Native web_search metering: tap the SSE to count completed
  // web_search_call items as they appear in response.output_item.done events.
  // Headers are sent before the body in HTTP/1.1 so the count can't be added
  // retroactively — instead emit telemetry async.
  let bodyToReturn = intercepted
  if (directWebSearchEnabled && intercepted) {
    const [tap, forward] = intercepted.tee()
    bodyToReturn = forward
    countNativeWebSearchFromSSE(tap)
      .then((meta) => recordWebSearchUsage(apiKeyId, meta))
      .catch(() => {})
    directHeaders["X-Web-Search-Engines"] = "copilot-native"
  }

  const streamResponse = new Response(bodyToReturn, { headers: directHeaders })
  if (apiKeyId) {
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, { stream: true, sourceApi: "responses", targetApi: "responses", upstream: upstreamId }).catch(() => {})
  }
  return streamResponse
}

/**
 * Direct /v1/responses passthrough for gpt-5.x — non-streaming branch with
 * heartbeat-while-waiting (raceWithHeartbeat keeps the socket alive while the
 * upstream JSON body is in flight).
 */
export async function handleDirectNonStreaming(
  ctx: RouteContext,
  payload: ResponsesPayload,
  directWebSearchEnabled: boolean,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId } = ctx
  const client = detectClient(ctx.userAgent)
  const model = payload.model

  const upstreamTimer = startTimer()
  const binding = await resolveBinding(state, ctx.userId, model, "responses", pinFromPayload(payload as unknown as Record<string, unknown>))
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `No responses upstream available for model: ${model}. Run GET /v1/models for available ids.` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream
  let upstreamMs = 0
  const syncPromise: Promise<RespJson> = (async () => {
    const response = await withCyberPolicyRetry(
      effectiveFlags(state, binding),
      () => withConnectionMismatchRetry(
        payload as unknown as Record<string, unknown>,
        (p) => provider.fetch(
          "responses",
          { method: "POST", body: JSON.stringify(p) },
          { operationName: "responses" },
        ),
      ),
    )
    upstreamMs = upstreamTimer()
    return (await response.json()) as RespJson
  })()

  const recordSync = async (j: RespJson) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(j, apiKeyId, model, client, upstreamId)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: j.usage?.input_tokens,
      outputTokens: j.usage?.output_tokens,
      sourceApi: "responses",
      targetApi: "responses",
      upstream: upstreamId,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response

  const j = raced.value
  await recordSync(j)
  const directJsonHeaders: Record<string, string> = { "Content-Type": "application/json" }
  if (directWebSearchEnabled) {
    const meta = countNativeWebSearchFromOutput(j.output)
    addWebSearchHeaders(directJsonHeaders, meta)
    recordWebSearchUsage(apiKeyId, meta)
  }
  return new Response(JSON.stringify(j), { headers: directJsonHeaders })
}
