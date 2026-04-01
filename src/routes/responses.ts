import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { callCopilotAPI } from "~/services/copilot"
import {
  fixApplyPatchTools,
  stripWebSearchTools,
  type ResponsesPayload,
  type ResponseTool,
} from "~/transforms"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"

interface RouteContext {
  state: AppState
  body: ResponsesPayload
  apiKeyId?: string
  colo: string
  requestId?: string
}

export const responsesRoute = new Elysia().post("/v1/responses", async (ctx) => {
  const { state, body, apiKeyId, colo, requestId } = ctx as unknown as RouteContext
  const elapsed = startTimer()

  const payload: ResponsesPayload = { ...(body as ResponsesPayload) }

  // Apply compatibility transforms
  fixApplyPatchTools(payload)

  // Strip web_search tools - we'll handle them ourselves (TODO)
  if (payload.tools) {
    payload.tools = stripWebSearchTools(payload.tools)
  }

  // TODO: Add web search interception here

  const upstreamTimer = startTimer()
  const response = await callCopilotAPI({
    endpoint: "/v1/responses",
    payload: payload as unknown as Record<string, unknown>,
    operationName: "create response",
    copilotToken: state.copilotToken,
    accountType: state.accountType,
  })
  const upstreamMs = upstreamTimer()

  // Check if streaming
  if (payload.stream === true) {
    const streamResponse = new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
    if (apiKeyId) {
      recordLatency(apiKeyId, payload.model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, { stream: true }).catch(() => {})
    }
    return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, payload.model) : streamResponse
  }

  const json = await response.json() as { usage?: { input_tokens?: number; output_tokens?: number } }
  const jsonResponse = new Response(JSON.stringify(json), {
    headers: { "Content-Type": "application/json" },
  })
  if (apiKeyId) {
    await trackNonStreamingUsage(json, apiKeyId, payload.model)
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    }).catch(() => {})
  }
  return jsonResponse
})
