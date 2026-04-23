import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { callCopilotAPI } from "~/services/copilot"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { detectClient } from "~/lib/client-detect"
import { checkQuota } from "~/lib/quota"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface ChatCompletionsPayload {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean; [key: string]: unknown }
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

type ChatJson = { usage?: { prompt_tokens?: number; completion_tokens?: number } }

function stripInjectedUsageChunk(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8")
  const encoder = new TextEncoder()
  let buffer = ""

  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          controller.enqueue(encoder.encode(line + "\n"))
          continue
        }
        const data = line.slice(6).trim()
        if (!data || data === "[DONE]") {
          controller.enqueue(encoder.encode(line + "\n"))
          continue
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: unknown[]
            usage?: unknown
          }
          // Drop usage-only chunk we injected (choices empty + usage present)
          const isUsageOnly =
            (!parsed.choices || parsed.choices.length === 0) && parsed.usage != null
          if (!isUsageOnly) {
            controller.enqueue(encoder.encode(line + "\n"))
          }
        } catch {
          controller.enqueue(encoder.encode(line + "\n"))
        }
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer))
      }
    },
  }))
}

async function handleChatCompletions(ctx: RouteContext): Promise<Response> {
  const { state, body, apiKeyId, colo, requestId, userAgent } = ctx
  const elapsed = startTimer()
  const client = detectClient(userAgent)

  if (apiKeyId) {
    const quota = await checkQuota(apiKeyId)
    if (!quota.allowed) {
      return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }), { status: 429, headers: { "Content-Type": "application/json" } })
    }
  }

  const payload = body as ChatCompletionsPayload
  const upstreamTimer = startTimer()

  if (payload.stream === true) {
    const clientWantsUsage = Boolean(payload.stream_options?.include_usage)
    payload.stream_options = {
      ...(payload.stream_options ?? {}),
      include_usage: true,
    }

    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: payload as unknown as Record<string, unknown>,
      operationName: "chat completions",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    const upstreamMs = upstreamTimer()
    // Inject SSE comment heartbeats during long thinking gaps so CF edge
    // doesn't close the idle connection. ":" prefix = SSE comment line,
    // ignored by every spec-compliant SSE parser including the OpenAI SDK.
    const heartbeated = wrapOpenAIHeartbeat(response.body)
    const streamResponse = new Response(heartbeated, {
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
    const tracked = apiKeyId
      ? trackStreamingUsage(streamResponse, apiKeyId, payload.model, client)
      : streamResponse

    if (clientWantsUsage) {
      return tracked
    }

    return new Response(stripInjectedUsageChunk(tracked.body!), {
      status: tracked.status,
      headers: tracked.headers,
    })
  }

  let upstreamMs = 0
  const syncPromise: Promise<ChatJson> = (async () => {
    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: payload as unknown as Record<string, unknown>,
      operationName: "chat completions",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    upstreamMs = upstreamTimer()
    return (await response.json()) as ChatJson
  })()

  const recordSync = async (j: ChatJson) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(j, apiKeyId, payload.model, client)
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: j.usage?.prompt_tokens,
      outputTokens: j.usage?.completion_tokens,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response

  const j = raced.value
  const jsonResponse = new Response(JSON.stringify(j), {
    headers: { "Content-Type": "application/json" },
  })
  await recordSync(j)
  return jsonResponse
}

export const chatCompletionsRoute = new Elysia()
  .post("/chat/completions", (ctx) => handleChatCompletions(ctx as unknown as RouteContext))
  .post("/v1/chat/completions", (ctx) => handleChatCompletions(ctx as unknown as RouteContext))
