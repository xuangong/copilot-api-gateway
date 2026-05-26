import { Elysia } from "elysia"

import { resolveBinding, parseModelRouting } from "~/lib/binding-resolver"
import type { AppState } from "~/lib/state"
import { trackNonStreamingUsage, consumeStreamForUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { detectClient } from "~/lib/client-detect"
import { checkQuota } from "~/lib/quota"
import {
  translateGeminiToOpenAI,
  type ChatCompletionResponse,
} from "~/services/gemini/format-conversion"
import {
  createChatToGeminiJSONStream,
  createChatToGeminiSSEStream,
  translateChatCompletionsToGeminiResponse,
} from "~/translators/gemini-via-chat"
import type { GeminiGenerateContentRequest, GeminiGenerateContentResponse } from "~/services/gemini/types"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import {
  hasGeminiWebSearch,
  interceptGeminiViaChat,
  loadWebSearchConfig,
  addWebSearchHeaders,
  recordWebSearchUsage,
  synthChatCompletionChunks,
} from "~/services/web-search"
import {
  normalizeCountTokensRequest,
  translateGeminiCountTokensToAnthropic,
  totalTokensFromUpstream,
  type GeminiCountTokensRequest,
} from "~/services/gemini/count-tokens"
import { handleGeminiViaMessages } from "./gemini-messages-fallback"
import { handleGeminiViaResponses } from "./gemini-responses-fallback"

interface RouteContext {
  state: AppState
  body: GeminiGenerateContentRequest
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  userId?: string
  params: { modelWithMethod: string }
}


// Map unsupported Gemini model names to supported Copilot equivalents
const GEMINI_MODEL_MAP: Record<string, string> = {
  "gemini-2.5-flash-lite": "gemini-3-flash-preview",
  "gemini-2.5-flash": "gemini-3-flash-preview",
}

function extractModelId(modelWithMethod: string): string {
  const parts = modelWithMethod.split(/[:\/]/)
  if (parts.length === 0 || !parts[0]) {
    throw new Error("Invalid model parameter")
  }
  // Strip Gemini CLI suffixes like "-customtools"
  const raw = parts[0].replace(/-customtools$/, "")
  return GEMINI_MODEL_MAP[raw] ?? raw
}

function isGenerateContentRequest(modelWithMethod: string): boolean {
  return (
    modelWithMethod.includes(":generateContent") ||
    modelWithMethod.endsWith("/generateContent")
  )
}

function isStreamGenerateContentRequest(modelWithMethod: string): boolean {
  return (
    modelWithMethod.includes(":streamGenerateContent") ||
    modelWithMethod.endsWith("/streamGenerateContent")
  )
}

async function handleGenerateContent(ctx: RouteContext) {
  const { state, body, apiKeyId, colo, requestId, userAgent, params } = ctx
  const elapsed = startTimer()
  const client = detectClient(userAgent)

  // Quota enforcement
  if (apiKeyId) {
    const quota = await checkQuota(apiKeyId)
    if (!quota.allowed) {
      return new Response(JSON.stringify({ error: { code: 429, message: quota.reason, status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "Content-Type": "application/json" } })
    }
  }

  const rawModel = extractModelId(params.modelWithMethod)
  const { upstreamPin, bareModel: model } = parseModelRouting(rawModel)

  // Route by upstream protocol of the bare model id (pin doesn't affect protocol shape).
  if (model.startsWith("claude-")) {
    return handleGeminiViaMessages(ctx, model, { kind: "sync" }, elapsed, upstreamPin)
  }
  if (model.startsWith("gpt-5")) {
    return handleGeminiViaResponses(ctx, model, { kind: "sync" }, elapsed, upstreamPin)
  }

  // ── Web-search interception ──
  if (hasGeminiWebSearch(body)) {
    const cfg = await loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)
    if (!cfg.enabled) {
      return new Response(
        JSON.stringify({ error: { code: 400, message: "Web search is not enabled for this API key.", status: "FAILED_PRECONDITION" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }
    const upstreamTimer = startTimer()
    const { chatResponse, geminiResponse, meta } = await interceptGeminiViaChat(
      body,
      model,
      {
        copilotToken: state.copilotToken,
        accountType: state.accountType,
        engineOptions: cfg.engineOptions!,
      },
    )
    const upstreamMs = upstreamTimer()
    if (apiKeyId) {
      await trackNonStreamingUsage(chatResponse, apiKeyId, model, client, state.upstream)
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: false,
        inputTokens: chatResponse.usage?.prompt_tokens,
        outputTokens: chatResponse.usage?.completion_tokens,
        userAgent,
        sourceApi: "gemini",
        targetApi: "chat-completions",
        upstream: state.upstream,
      }).catch(() => {})
      recordWebSearchUsage(apiKeyId, meta)
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    addWebSearchHeaders(headers, meta)
    return new Response(JSON.stringify(geminiResponse), { headers })
  }

  const openAIPayload = translateGeminiToOpenAI(body, model)
  openAIPayload.stream = false

  // Strip undefined/null values to avoid sending them
  const cleanPayload = JSON.parse(JSON.stringify(openAIPayload)) as Record<string, unknown>

  const upstreamTimer = startTimer()
  const binding = await resolveBinding(state, ctx.userId, model, "chat_completions", upstreamPin)
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { code: 404, message: `No chat-completions upstream available for model: ${model}. Run GET /v1/models for available ids.`, status: "NOT_FOUND" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream
  let upstreamMs = 0
  const syncPromise: Promise<{ chat: ChatCompletionResponse; gemini: GeminiGenerateContentResponse }> = (async () => {
    const response = await provider.callChatCompletions(
      cleanPayload,
      { operationName: "gemini generate content" },
    )
    upstreamMs = upstreamTimer()
    const json = (await response.json()) as ChatCompletionResponse
    return { chat: json, gemini: translateChatCompletionsToGeminiResponse(json, model) }
  })()

  const recordSync = async (result: { chat: ChatCompletionResponse }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(
      result.chat,
      apiKeyId,
      model,
      client,
      upstreamId,
    )
    recordLatency(
      apiKeyId,
      model,
      colo,
      {
        totalMs: elapsed(),
        upstreamMs,
        ttfbMs: upstreamMs,
        tokenMiss: state.tokenMiss,
      },
      requestId,
      {
        stream: false,
        inputTokens: result.chat.usage?.prompt_tokens,
        outputTokens: result.chat.usage?.completion_tokens,
        sourceApi: "gemini",
        targetApi: "chat-completions",
        upstream: upstreamId,
      },
    ).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, {
    serialize: (v) => JSON.stringify(v.gemini),
    onResolve: recordSync,
  })
  if (raced.kind === "stream") return raced.response

  await recordSync(raced.value)
  return new Response(JSON.stringify(raced.value.gemini), {
    headers: { "Content-Type": "application/json" },
  })
}

function isCountTokensRequest(modelWithMethod: string): boolean {
  return (
    modelWithMethod.includes(":countTokens") ||
    modelWithMethod.endsWith("/countTokens")
  )
}

async function handleCountTokens(ctx: RouteContext) {
  const { state, body, params } = ctx
  const rawModel = extractModelId(params.modelWithMethod)
  const { upstreamPin, bareModel: model } = parseModelRouting(rawModel)
  const normalized = normalizeCountTokensRequest(body as unknown as GeminiCountTokensRequest)
  const payload = translateGeminiCountTokensToAnthropic(normalized, model)

  const binding = await resolveBinding(state, ctx.userId, model, "messages_count_tokens", upstreamPin)
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { code: 404, message: `No messages_count_tokens upstream available for model: ${model}. Run GET /v1/models for available ids.`, status: "NOT_FOUND" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const response = await binding.provider.callMessagesCountTokens(
    payload as unknown as Record<string, unknown>,
    { operationName: "gemini count tokens" },
  )

  if (!response.ok) {
    const text = await response.text()
    return new Response(
      JSON.stringify({ error: { code: response.status, message: text || "Upstream count tokens failed", status: "INTERNAL" } }),
      { status: response.status, headers: { "Content-Type": "application/json" } },
    )
  }

  const parsed = (await response.json()) as unknown
  const totalTokens = totalTokensFromUpstream(parsed)
  if (totalTokens === null) {
    return new Response(
      JSON.stringify({ error: { code: 502, message: "Invalid upstream count tokens response", status: "INTERNAL" } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    )
  }

  return new Response(JSON.stringify({ totalTokens }), {
    headers: { "Content-Type": "application/json" },
  })
}

async function handleStreamGenerateContent(
  ctx: RouteContext,
  useSSE: boolean,
) {
  const { state, body, apiKeyId, colo, requestId, userAgent, params } = ctx
  const elapsed = startTimer()
  const client = detectClient(userAgent)

  // Quota enforcement
  if (apiKeyId) {
    const quota = await checkQuota(apiKeyId)
    if (!quota.allowed) {
      return new Response(JSON.stringify({ error: { code: 429, message: quota.reason, status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "Content-Type": "application/json" } })
    }
  }

  const rawModel = extractModelId(params.modelWithMethod)
  const { upstreamPin, bareModel: model } = parseModelRouting(rawModel)

  if (model.startsWith("claude-")) {
    return handleGeminiViaMessages(ctx, model, { kind: "stream", useSSE }, elapsed, upstreamPin)
  }
  if (model.startsWith("gpt-5")) {
    return handleGeminiViaResponses(ctx, model, { kind: "stream", useSSE }, elapsed, upstreamPin)
  }

  // ── Web-search interception (synthesized single chunk into stream pipeline) ──
  if (hasGeminiWebSearch(body)) {
    const cfg = await loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)
    if (!cfg.enabled) {
      return new Response(
        JSON.stringify({ error: { code: 400, message: "Web search is not enabled for this API key.", status: "FAILED_PRECONDITION" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }
    const upstreamTimer = startTimer()
    const { chatResponse, meta } = await interceptGeminiViaChat(
      body,
      model,
      {
        copilotToken: state.copilotToken,
        accountType: state.accountType,
        engineOptions: cfg.engineOptions!,
      },
    )
    const upstreamMs = upstreamTimer()
    if (apiKeyId) {
      await trackNonStreamingUsage(chatResponse, apiKeyId, model, client, state.upstream)
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: true,
        inputTokens: chatResponse.usage?.prompt_tokens,
        outputTokens: chatResponse.usage?.completion_tokens,
        userAgent,
        sourceApi: "gemini",
        targetApi: "chat-completions",
        upstream: state.upstream,
      }).catch(() => {})
      recordWebSearchUsage(apiKeyId, meta)
    }

    const synthesized = synthChatCompletionChunks(chatResponse)
    const transformStream = useSSE
      ? createChatToGeminiSSEStream()
      : createChatToGeminiJSONStream()
    const heartbeated = useSSE ? wrapOpenAIHeartbeat(synthesized) : synthesized
    const transformedBody = heartbeated?.pipeThrough(transformStream)
    const headers: Record<string, string> = useSSE
      ? { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }
      : { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }
    addWebSearchHeaders(headers, meta)
    return new Response(transformedBody, { headers })
  }

  const openAIPayload = translateGeminiToOpenAI(body, model)
  openAIPayload.stream = true
  openAIPayload.stream_options = { include_usage: true }

  // Strip undefined/null values to avoid sending them
  const cleanPayload = JSON.parse(JSON.stringify(openAIPayload)) as Record<string, unknown>

  const upstreamTimer = startTimer()
  const binding = await resolveBinding(state, ctx.userId, model, "chat_completions", upstreamPin)
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { code: 404, message: `No chat-completions upstream available for model: ${model}. Run GET /v1/models for available ids.`, status: "NOT_FOUND" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const upstreamId = binding.upstream
  const response = await binding.provider.callChatCompletions(
    cleanPayload,
    { operationName: "gemini stream generate content" },
  )
  const upstreamMs = upstreamTimer()

  if (apiKeyId) {
    recordLatency(
      apiKeyId,
      model,
      colo,
      {
        totalMs: elapsed(),
        upstreamMs,
        ttfbMs: upstreamMs,
        tokenMiss: state.tokenMiss,
      },
      requestId,
      { stream: true, sourceApi: "gemini", targetApi: "chat-completions", upstream: upstreamId },
    ).catch(() => {})
  }

  const transformStream = useSSE
    ? createChatToGeminiSSEStream()
    : createChatToGeminiJSONStream()

  // Heartbeat: only safe to inject on the SSE path. The alt=json path
  // returns a JSON array stream where any injected bytes would break
  // JSON.parse on the client. Long alt=json streams should switch to
  // ?alt=sse to benefit from keepalive.
  const upstreamBody = response.body
  const heartbeated = useSSE ? wrapOpenAIHeartbeat(upstreamBody) : upstreamBody

  let usageBranch: ReadableStream<Uint8Array> | null = null
  let transformBranch: ReadableStream<Uint8Array> | null = null
  if (heartbeated) {
    const [a, b] = heartbeated.tee()
    usageBranch = a
    transformBranch = b
  }
  if (apiKeyId && usageBranch) {
    consumeStreamForUsage(usageBranch, apiKeyId, model, client, upstreamId)
  }
  const transformedBody = transformBranch?.pipeThrough(transformStream)
  return new Response(transformedBody, {
    headers: useSSE
      ? {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        }
      : {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
  })
}

export const geminiRoute = new Elysia().post(
  "/v1beta/models/:modelWithMethod",
  async (ctx) => {
    const routeCtx = ctx as unknown as RouteContext
    const { modelWithMethod } = routeCtx.params

    if (isGenerateContentRequest(modelWithMethod)) {
      return handleGenerateContent(routeCtx)
    }

    if (isCountTokensRequest(modelWithMethod)) {
      return handleCountTokens(routeCtx)
    }

    if (isStreamGenerateContentRequest(modelWithMethod)) {
      const useSSE =
        (ctx.query as Record<string, string>)?.alt === "sse"
      return handleStreamGenerateContent(routeCtx, useSSE)
    }

    return new Response(
      JSON.stringify({ error: { message: "Unknown method", code: 404 } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  },
)
