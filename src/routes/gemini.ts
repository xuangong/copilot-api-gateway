import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { callCopilotAPI } from "~/services/copilot"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { detectClient } from "~/lib/client-detect"
import { checkQuota } from "~/lib/quota"
import {
  translateGeminiToOpenAI,
  translateOpenAIToGemini,
  translateChunkToGemini,
  createStreamState,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
} from "~/services/gemini/format-conversion"
import type { GeminiGenerateContentRequest } from "~/services/gemini/types"
import { createSSETransform } from "~/lib/sse-transform"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"

interface RouteContext {
  state: AppState
  body: GeminiGenerateContentRequest
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
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

  const model = extractModelId(params.modelWithMethod)
  const openAIPayload = translateGeminiToOpenAI(body, model)
  openAIPayload.stream = false

  // Strip undefined/null values to avoid sending them
  const cleanPayload = JSON.parse(JSON.stringify(openAIPayload)) as Record<string, unknown>

  const upstreamTimer = startTimer()
  let upstreamMs = 0
  const syncPromise: Promise<{ chat: ChatCompletionResponse; gemini: ReturnType<typeof translateOpenAIToGemini> }> = (async () => {
    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: cleanPayload,
      operationName: "gemini generate content",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    upstreamMs = upstreamTimer()
    const json = (await response.json()) as ChatCompletionResponse
    return { chat: json, gemini: translateOpenAIToGemini(json, model) }
  })()

  const recordSync = async (result: { chat: ChatCompletionResponse }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(
      {
        usage: {
          input_tokens: result.chat.usage?.prompt_tokens,
          output_tokens: result.chat.usage?.completion_tokens,
        },
      },
      apiKeyId,
      model,
      client,
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

  const model = extractModelId(params.modelWithMethod)
  const openAIPayload = translateGeminiToOpenAI(body, model)
  openAIPayload.stream = true

  // Strip undefined/null values to avoid sending them
  const cleanPayload = JSON.parse(JSON.stringify(openAIPayload)) as Record<string, unknown>

  const upstreamTimer = startTimer()
  const response = await callCopilotAPI({
    endpoint: "/chat/completions",
    payload: cleanPayload,
    operationName: "gemini stream generate content",
    copilotToken: state.copilotToken,
    accountType: state.accountType,
  })
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
      { stream: true },
    ).catch(() => {})
  }

  const streamState = createStreamState(model)
  const encoder = new TextEncoder()

  const transformStream = createSSETransform((data) => {
    try {
      const openAIChunk = JSON.parse(data) as ChatCompletionChunk
      const geminiChunk = translateChunkToGemini(openAIChunk, streamState)

      if (geminiChunk) {
        if (useSSE) {
          return encoder.encode(`data: ${JSON.stringify(geminiChunk)}\n\n`)
        } else {
          return encoder.encode(JSON.stringify(geminiChunk) + "\n")
        }
      }
    } catch {
      // Skip invalid JSON chunks
    }
    return null
  })

  const transformedBody = response.body?.pipeThrough(transformStream)

  const streamResponse = new Response(transformedBody, {
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

  return apiKeyId
    ? trackStreamingUsage(streamResponse, apiKeyId, model, client)
    : streamResponse
}

export const geminiRoute = new Elysia().post(
  "/v1beta/models/:modelWithMethod",
  async (ctx) => {
    const routeCtx = ctx as unknown as RouteContext
    const { modelWithMethod } = routeCtx.params

    if (isGenerateContentRequest(modelWithMethod)) {
      return handleGenerateContent(routeCtx)
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
