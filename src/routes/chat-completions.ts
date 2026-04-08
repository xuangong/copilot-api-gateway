import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { callCopilotAPI } from "~/services/copilot"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { detectClient } from "~/lib/client-detect"

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface ChatCompletionsPayload {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  top_p?: number
}

interface RouteContext {
  state: AppState
  body: ChatCompletionsPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
}

export const chatCompletionsRoute = new Elysia()
  .post("/chat/completions", async (ctx) => {
    const { state, body, apiKeyId, colo, requestId, userAgent } = ctx as unknown as RouteContext
    const elapsed = startTimer()
    const client = detectClient(userAgent)

    const payload = body as ChatCompletionsPayload

    const upstreamTimer = startTimer()
    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: payload as unknown as Record<string, unknown>,
      operationName: "chat completions",
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
      return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, payload.model, client) : streamResponse
    }

    const json = await response.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
    const jsonResponse = new Response(JSON.stringify(json), {
      headers: { "Content-Type": "application/json" },
    })
    if (apiKeyId) {
      await trackNonStreamingUsage(json, apiKeyId, payload.model, client)
      recordLatency(apiKeyId, payload.model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: false,
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      }).catch(() => {})
    }
    return jsonResponse
  })
  .post("/v1/chat/completions", async (ctx) => {
    const { state, body, apiKeyId, colo, requestId, userAgent } = ctx as unknown as RouteContext
    const elapsed = startTimer()
    const client = detectClient(userAgent)

    const payload = body as ChatCompletionsPayload

    const upstreamTimer = startTimer()
    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: payload as unknown as Record<string, unknown>,
      operationName: "chat completions",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    const upstreamMs = upstreamTimer()

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
      return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, payload.model, client) : streamResponse
    }

    const json2 = await response.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
    const jsonResponse = new Response(JSON.stringify(json2), {
      headers: { "Content-Type": "application/json" },
    })
    if (apiKeyId) {
      await trackNonStreamingUsage(json2, apiKeyId, payload.model, client)
      recordLatency(apiKeyId, payload.model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: false,
        inputTokens: json2.usage?.prompt_tokens,
        outputTokens: json2.usage?.completion_tokens,
      }).catch(() => {})
    }
    return jsonResponse
  })
