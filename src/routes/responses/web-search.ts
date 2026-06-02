import { detectClient } from "~/lib/client-detect"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { trackNonStreamingUsage } from "~/middleware/usage"
import {
  addWebSearchHeaders,
  interceptResponsesViaChat,
  loadWebSearchConfig,
  recordWebSearchUsage,
  synthResponsesSSE,
} from "~/services/web-search"
import type { ResponsesPayload } from "~/transforms"

import { type RouteContext } from "./utils"

/**
 * Chat-fallback web_search path (gpt-4.x etc.): upstream doesn't support
 * web_search, so we run the intercept loop via /chat/completions and project
 * the result back into the Responses envelope.
 */
export async function handleWebSearchIntercepted(
  ctx: RouteContext,
  payload: ResponsesPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const model = payload.model

  const cfg = await loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)
  if (!cfg.enabled) return cfg.errorResponse!

  const upstreamTimer = startTimer()
  const { responsesResult, chatResponse, meta } = await interceptResponsesViaChat(payload, {
    copilotToken: state.copilotToken,
    accountType: state.accountType,
    engineOptions: cfg.engineOptions!,
    apiKeyId,
  })
  const upstreamMs = upstreamTimer()

  const recordSide = async () => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(chatResponse, apiKeyId, model, client, state.upstream)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: payload.stream === true,
      inputTokens: responsesResult.usage.input_tokens,
      outputTokens: responsesResult.usage.output_tokens,
      userAgent,
      sourceApi: "responses",
      targetApi: "chat-completions",
      upstream: state.upstream,
    }).catch(() => {})
    recordWebSearchUsage(apiKeyId, meta)
  }

  if (payload.stream === true) {
    const synthesized = synthResponsesSSE(responsesResult)
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    }
    addWebSearchHeaders(headers, meta)
    const streamResponse = new Response(synthesized, { headers })
    await recordSide()
    return streamResponse
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  addWebSearchHeaders(headers, meta)
  const jsonResponse = new Response(JSON.stringify(responsesResult), { headers })
  await recordSide()
  return jsonResponse
}
