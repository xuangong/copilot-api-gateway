import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { callCopilotAPI } from "~/services/copilot"
import {
  fixApplyPatchTools,
  stripWebSearchTools,
  type ResponsesPayload,
} from "~/transforms"
import {
  translateResponsesToChatCompletions,
  translateChatCompletionsToResponses,
  translateChunkToResponsesEvents,
  createStreamState,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
} from "~/services/responses"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { createSSETransform } from "~/lib/sse-transform"
import { detectClient } from "~/lib/client-detect"
import { checkQuota } from "~/lib/quota"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"

interface RouteContext {
  state: AppState
  body: ResponsesPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
}

/**
 * Determine whether to use /v1/responses (direct) or /chat/completions (conversion).
 *
 * Strategy: only gpt-5.x series support /v1/responses natively.
 * All older models (gpt-4.x, gpt-4o, gpt-4, gpt-3.x) use /chat/completions.
 */
function shouldUseChatFallback(model: string): boolean {
  // gpt-5.x and variants (gpt-5.1, gpt-5.2, gpt-5.3-codex, gpt-5.4, etc.) — responses native
  if (model.startsWith("gpt-5")) return false
  // Everything else — chat fallback
  return true
}

/**
 * Build a TransformStream that converts Chat Completions SSE → Responses SSE
 */
function buildStreamTransform(
  payload: ResponsesPayload,
  model: string,
): TransformStream<Uint8Array, Uint8Array> {
  const streamState = createStreamState(model)
  const encoder = new TextEncoder()

  return createSSETransform((data) => {
    try {
      const chatChunk = JSON.parse(data) as ChatCompletionChunk
      const events = translateChunkToResponsesEvents(chatChunk, streamState, payload)

      if (events.length > 0) {
        const parts: string[] = []
        for (const event of events) {
          parts.push(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
        }
        return encoder.encode(parts.join(""))
      }
    } catch {
      // Skip invalid JSON chunks
    }
    return null
  })
}

const handleResponses = async (ctx: unknown) => {
  const { state, body, apiKeyId, colo, requestId, userAgent } = ctx as unknown as RouteContext
  const elapsed = startTimer()
  const client = detectClient(userAgent)

  // Quota enforcement
  if (apiKeyId) {
    const quota = await checkQuota(apiKeyId)
    if (!quota.allowed) {
      return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }), { status: 429, headers: { "Content-Type": "application/json" } })
    }
  }

  const payload: ResponsesPayload = { ...(body as ResponsesPayload) }

  // Apply compatibility transforms
  fixApplyPatchTools(payload)

  if (payload.tools) {
    payload.tools = stripWebSearchTools(payload.tools)
  }

  const model = payload.model
  const useChatFallback = shouldUseChatFallback(model)

  if (!useChatFallback) {
    // ── Direct passthrough to /v1/responses ──
    const upstreamTimer = startTimer()

    if (payload.stream === true) {
      const response = await callCopilotAPI({
        endpoint: "/v1/responses",
        payload: payload as unknown as Record<string, unknown>,
        operationName: "responses",
        copilotToken: state.copilotToken,
        accountType: state.accountType,
      })
      const upstreamMs = upstreamTimer()
      const streamResponse = new Response(response.body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      })
      if (apiKeyId) {
        recordLatency(apiKeyId, model, colo, {
          totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
        }, requestId, { stream: true }).catch(() => {})
      }
      return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, model, client) : streamResponse
    }

    type RespJson = { usage?: { input_tokens?: number; output_tokens?: number } }
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
    return new Response(JSON.stringify(j), {
      headers: { "Content-Type": "application/json" },
    })
  }

  // ── Chat Completions fallback with format conversion ──

  const chatPayload = translateResponsesToChatCompletions(payload, model)

  if (payload.stream === true) {
    chatPayload.stream = true

    const upstreamTimer = startTimer()
    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: chatPayload as unknown as Record<string, unknown>,
      operationName: "responses (via chat)",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    const upstreamMs = upstreamTimer()

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, { stream: true }).catch(() => {})
    }

    const transformedBody = response.body?.pipeThrough(buildStreamTransform(payload, model))

    const streamResponse = new Response(transformedBody, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })

    return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, model, client) : streamResponse
  }

  // Non-streaming fallback
  chatPayload.stream = false

  const upstreamTimer = startTimer()
  let upstreamMs = 0
  const syncPromise: Promise<ReturnType<typeof translateChatCompletionsToResponses>> = (async () => {
    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: chatPayload as unknown as Record<string, unknown>,
      operationName: "responses (via chat)",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    upstreamMs = upstreamTimer()
    const chatResponse = (await response.json()) as ChatCompletionResponse
    return translateChatCompletionsToResponses(chatResponse, model, payload)
  })()

  const recordSync = async (responsesResult: ReturnType<typeof translateChatCompletionsToResponses>) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(
      { usage: { input_tokens: responsesResult.usage.input_tokens, output_tokens: responsesResult.usage.output_tokens } },
      apiKeyId,
      model,
      client,
    )
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: responsesResult.usage.input_tokens,
      outputTokens: responsesResult.usage.output_tokens,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response

  const responsesResult = raced.value
  await recordSync(responsesResult)
  return new Response(JSON.stringify(responsesResult), {
    headers: { "Content-Type": "application/json" },
  })
}

export const responsesRoute = new Elysia()
  .post("/v1/responses", handleResponses)
  .post("/responses", handleResponses)
