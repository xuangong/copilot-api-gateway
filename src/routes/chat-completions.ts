import { Elysia } from "elysia"

import { resolveBinding } from "~/lib/binding-resolver"
import type { AppState } from "~/lib/state"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { detectClient } from "~/lib/client-detect"
import { checkQuota } from "~/lib/quota"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import { createFrameBuffer } from "~/lib/sse/parser"
import { createChatWhitespaceAbortStream, disableChatCompletionsReasoningOnForcedToolChoice } from "~/transforms"
import {
  hasOpenAIWebSearch,
  interceptOpenAIChat,
  type OpenAIChatPayload,
  loadWebSearchConfig,
  addWebSearchHeaders,
  recordWebSearchUsage,
  replayChatCompletionAsSSE,
} from "~/services/web-search"

import { handleChatCompletionsViaMessages } from "./chat-completions-messages-fallback"
import { handleChatCompletionsViaResponses } from "./chat-completions-responses-fallback"
import type { ChatCompletionsPayload as TranslatorChatPayload } from "~/services/gemini/format-conversion"

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
  userId?: string
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

export async function handleChatCompletions(ctx: RouteContext): Promise<Response> {
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
  disableChatCompletionsReasoningOnForcedToolChoice(
    payload as Parameters<typeof disableChatCompletionsReasoningOnForcedToolChoice>[0],
    state.enabledFlags ?? new Set(),
  )
  const upstreamTimer = startTimer()

  // claude-* 模型走 Messages 上游,需要 Chat ↔ Messages 双向翻译
  if (payload.model.startsWith("claude-")) {
    return handleChatCompletionsViaMessages(
      ctx as unknown as Parameters<typeof handleChatCompletionsViaMessages>[0],
      payload as unknown as TranslatorChatPayload,
      elapsed,
    )
  }

  // gpt-5.x 只在 /v1/responses 上游;Chat ↔ Responses 双向翻译
  if (payload.model.startsWith("gpt-5")) {
    return handleChatCompletionsViaResponses(
      ctx as unknown as Parameters<typeof handleChatCompletionsViaResponses>[0],
      payload as unknown as Parameters<typeof handleChatCompletionsViaResponses>[1],
      elapsed,
    )
  }

  // Resolve binding for non-fallback path. Falls back to the request's
  // single-account Copilot context when no managed upstream serves the
  // requested model, keeping pre-registry deployments working.
  const binding = await resolveBinding(state, ctx.userId, payload.model, "chat_completions")
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `No chat-completions upstream available for model: ${payload.model}` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream

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
        await trackNonStreamingUsage(response, apiKeyId, payload.model, client, upstreamId)
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
          upstream: upstreamId,
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
    let responseBody = response.body
    if (apiKeyId && responseBody) {
      const [usageBranch, forwardBranch] = responseBody.tee()
      consumeStreamForUsage(usageBranch, apiKeyId, payload.model, client, upstreamId)
      responseBody = forwardBranch
    }
    const heartbeated = wrapOpenAIHeartbeat(responseBody)
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
      }, requestId, { stream: true, sourceApi: "chat-completions", targetApi: "chat-completions", upstream: upstreamId }).catch(() => {})
    }
    if (clientWantsUsage) {
      return streamResponse
    }

    return new Response(stripInjectedUsageChunk(streamResponse.body!), {
      status: streamResponse.status,
      headers: streamResponse.headers,
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
    await trackNonStreamingUsage(j, apiKeyId, payload.model, client, upstreamId)
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: j.usage?.prompt_tokens,
      outputTokens: j.usage?.completion_tokens,
      sourceApi: "chat-completions",
      targetApi: "chat-completions",
      upstream: upstreamId,
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
