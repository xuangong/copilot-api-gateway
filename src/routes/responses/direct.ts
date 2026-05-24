import { detectClient } from "~/lib/client-detect"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { callCopilotAPI } from "~/services/copilot"
import {
  addWebSearchHeaders,
  recordWebSearchUsage,
} from "~/services/web-search"
import type { ResponsesPayload } from "~/transforms"

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
  const response = await callCopilotAPI({
    endpoint: "/v1/responses",
    payload: payload as unknown as Record<string, unknown>,
    operationName: "responses",
    copilotToken: state.copilotToken,
    accountType: state.accountType,
  })
  const upstreamMs = upstreamTimer()

  // Inject SSE comment heartbeats during long thinking gaps so the downstream
  // connection never goes 60s without a byte (which would trip client SDK
  // read-timeouts or intermediate proxies).
  const heartbeated = wrapOpenAIHeartbeat(response.body)
  const directHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  }

  // Native web_search metering: tap the SSE to count completed
  // web_search_call items as they appear in response.output_item.done events.
  // Headers are sent before the body in HTTP/1.1 so the count can't be added
  // retroactively — instead emit telemetry async.
  let bodyToReturn = heartbeated
  if (directWebSearchEnabled && heartbeated) {
    const [tap, forward] = heartbeated.tee()
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
    }, requestId, { stream: true }).catch(() => {})
  }
  return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, model, client) : streamResponse
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
  let upstreamMs = 0
  const syncPromise: Promise<RespJson> = (async () => {
    const response = await callCopilotAPI({
      endpoint: "/v1/responses",
      payload: payload as unknown as Record<string, unknown>,
      operationName: "responses",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    upstreamMs = upstreamTimer()
    return (await response.json()) as RespJson
  })()

  const recordSync = async (j: RespJson) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(j, apiKeyId, model, client)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: j.usage?.input_tokens,
      outputTokens: j.usage?.output_tokens,
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
