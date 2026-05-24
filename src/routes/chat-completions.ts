import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { createCopilotProvider } from "~/providers/registry"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { detectClient } from "~/lib/client-detect"
import { checkQuota } from "~/lib/quota"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import { createFrameBuffer } from "~/lib/sse/parser"
import { createChatWhitespaceAbortStream } from "~/transforms"
import {
  hasOpenAIWebSearch,
  interceptOpenAIChat,
  type OpenAIChatPayload,
  loadWebSearchConfig,
  addWebSearchHeaders,
  recordWebSearchUsage,
  replayChatCompletionAsSSE,
} from "~/services/web-search"

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
  tools?: unknown[]
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
  const encoder = new TextEncoder()
  const frameBuffer = createFrameBuffer()

  const processFrame = (frame: { raw: string; data?: string }, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!frame.data || frame.data === "[DONE]") {
      controller.enqueue(encoder.encode(frame.raw))
      return
    }
    try {
      const parsed = JSON.parse(frame.data) as {
        choices?: unknown[]
        usage?: unknown
      }
      const isUsageOnly =
        (!parsed.choices || parsed.choices.length === 0) && parsed.usage != null
      if (!isUsageOnly) controller.enqueue(encoder.encode(frame.raw))
    } catch {
      controller.enqueue(encoder.encode(frame.raw))
    }
  }

  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      for (const frame of frameBuffer.push(chunk)) processFrame(frame, controller)
    },
    flush(controller) {
      const tail = frameBuffer.flush()
      if (tail) processFrame(tail, controller)
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
  const provider = createCopilotProvider({ copilotToken: state.copilotToken, accountType: state.accountType })

  // ── Web-search interception ───────────────────────────────────────────
  // If client sent a web_search-style tool, run the multi-turn intercept
  // loop synchronously and either return JSON or replay as a single-chunk
  // SSE for streaming clients. Anthropic-equivalent flow lives in messages.ts.
  if (hasOpenAIWebSearch(payload as unknown as OpenAIChatPayload)) {
    const cfg = await loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)
    if (!cfg.enabled) return cfg.errorResponse!

    const wantsStream = payload.stream === true
    const { response, meta } = await interceptOpenAIChat(
      payload as unknown as OpenAIChatPayload,
      {
        copilotToken: state.copilotToken,
        accountType: state.accountType,
        engineOptions: cfg.engineOptions!,
      },
    )
    const upstreamMs = upstreamTimer()

    const recordSide = async () => {
      if (apiKeyId) {
        await trackNonStreamingUsage(response, apiKeyId, payload.model, client)
        const usage = response.usage
        recordLatency(apiKeyId, payload.model, colo, {
          totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
        }, requestId, {
          stream: wantsStream,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
          userAgent,
          sourceApi: "chat-completions",
          targetApi: "chat-completions",
        }).catch(() => {})
        recordWebSearchUsage(apiKeyId, meta)
      }
    }

    if (wantsStream) {
      const sseBody = replayChatCompletionAsSSE(response)
      const heartbeated = wrapOpenAIHeartbeat(sseBody)
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      }
      addWebSearchHeaders(headers, meta)
      const streamResponse = new Response(heartbeated, { headers })
      await recordSide()
      return streamResponse
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    addWebSearchHeaders(headers, meta)
    const jsonResponse = new Response(JSON.stringify(response), { headers })
    await recordSide()
    return jsonResponse
  }

  if (payload.stream === true) {
    const clientWantsUsage = Boolean(payload.stream_options?.include_usage)
    payload.stream_options = {
      ...(payload.stream_options ?? {}),
      include_usage: true,
    }

    const response = await provider.callChatCompletions(
      payload as unknown as Record<string, unknown>,
      { operationName: "chat completions" },
    )
    const upstreamMs = upstreamTimer()
    // Inject SSE comment heartbeats during long thinking gaps so the
    // downstream connection never goes 60s without a byte (which would
    // trip client SDK read-timeouts or intermediate proxies). ":" prefix
    // = SSE comment line, ignored by every spec-compliant SSE parser
    // including the OpenAI SDK.
    const heartbeated = wrapOpenAIHeartbeat(response.body)
    // Abort streams that degenerate into whitespace-only tool argument deltas.
    const guarded = heartbeated
      ? heartbeated.pipeThrough(createChatWhitespaceAbortStream())
      : null
    const streamResponse = new Response(guarded, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
    if (apiKeyId) {
      recordLatency(apiKeyId, payload.model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, { stream: true, sourceApi: "chat-completions", targetApi: "chat-completions" }).catch(() => {})
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
    const response = await provider.callChatCompletions(
      payload as unknown as Record<string, unknown>,
      { operationName: "chat completions" },
    )
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
      sourceApi: "chat-completions",
      targetApi: "chat-completions",
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
