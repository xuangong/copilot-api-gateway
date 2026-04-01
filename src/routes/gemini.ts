import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { callCopilotAPI } from "~/services/copilot"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import {
  translateGeminiToOpenAI,
  translateOpenAIToGemini,
  translateChunkToGemini,
  createStreamState,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
} from "~/services/gemini/format-conversion"
import type { GeminiGenerateContentRequest } from "~/services/gemini/types"

interface RouteContext {
  state: AppState
  body: GeminiGenerateContentRequest
  apiKeyId?: string
  colo: string
  requestId?: string
  params: { modelWithMethod: string }
}

const STREAM_DONE_MARKER = "[DONE]"

function extractModelId(modelWithMethod: string): string {
  const parts = modelWithMethod.split(/[:\/]/)
  if (parts.length === 0 || !parts[0]) {
    throw new Error("Invalid model parameter")
  }
  return parts[0]
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
  const { state, body, apiKeyId, colo, requestId, params } = ctx
  const elapsed = startTimer()

  const model = extractModelId(params.modelWithMethod)
  const openAIPayload = translateGeminiToOpenAI(body, model)
  openAIPayload.stream = false

  const upstreamTimer = startTimer()
  const response = await callCopilotAPI({
    endpoint: "/chat/completions",
    payload: openAIPayload as unknown as Record<string, unknown>,
    operationName: "gemini generate content",
    copilotToken: state.copilotToken,
    accountType: state.accountType,
  })
  const upstreamMs = upstreamTimer()

  const json = (await response.json()) as ChatCompletionResponse
  const geminiResponse = translateOpenAIToGemini(json, model)

  if (apiKeyId) {
    await trackNonStreamingUsage(
      {
        usage: {
          input_tokens: json.usage?.prompt_tokens,
          output_tokens: json.usage?.completion_tokens,
        },
      },
      apiKeyId,
      model,
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
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      },
    ).catch(() => {})
  }

  return new Response(JSON.stringify(geminiResponse), {
    headers: { "Content-Type": "application/json" },
  })
}

async function handleStreamGenerateContent(
  ctx: RouteContext,
  useSSE: boolean,
) {
  const { state, body, apiKeyId, colo, requestId, params } = ctx
  const elapsed = startTimer()

  const model = extractModelId(params.modelWithMethod)
  const openAIPayload = translateGeminiToOpenAI(body, model)
  openAIPayload.stream = true

  const upstreamTimer = startTimer()
  const response = await callCopilotAPI({
    endpoint: "/chat/completions",
    payload: openAIPayload as unknown as Record<string, unknown>,
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

  const transformStream = new TransformStream({
    transform(chunk: Uint8Array, controller) {
      const text = new TextDecoder().decode(chunk)
      const lines = text.split("\n")

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (data === STREAM_DONE_MARKER || !data) continue

        try {
          const openAIChunk = JSON.parse(data) as ChatCompletionChunk
          const geminiChunk = translateChunkToGemini(openAIChunk, streamState)

          if (geminiChunk) {
            if (useSSE) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(geminiChunk)}\n\n`),
              )
            } else {
              controller.enqueue(
                encoder.encode(JSON.stringify(geminiChunk) + "\n"),
              )
            }
          }
        } catch {
          // Skip invalid JSON chunks
        }
      }
    },
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
    ? trackStreamingUsage(streamResponse, apiKeyId, model)
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
