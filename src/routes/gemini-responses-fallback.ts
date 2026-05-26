/**
 * Responses-upstream fallback for /v1beta/models/:model:generateContent
 * (and streamGenerateContent). Used when the requested Gemini model
 * resolves to a gpt-5.x upstream that only serves /v1/responses.
 *
 * Translates Gemini → Responses on the request path, and Responses SSE/JSON
 * → Gemini SSE/JSON on the response path via gemini-via-responses.
 */

import { detectClient } from "~/lib/client-detect"
import { resolveBinding } from "~/lib/binding-resolver"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import type { AppState } from "~/lib/state"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import { withConnectionMismatchRetry } from "~/services/copilot/connection-mismatch"
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
} from "~/services/gemini/types"
import {
  createResponsesToGeminiJSONStream,
  createResponsesToGeminiSSEStream,
  translateGeminiToResponses,
  translateResponsesToGeminiResponse,
} from "~/translators/gemini-via-responses"

interface RouteContext {
  state: AppState
  body: GeminiGenerateContentRequest
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  userId?: string
}

export async function handleGeminiViaResponses(
  ctx: RouteContext,
  model: string,
  mode: { kind: "sync" } | { kind: "stream"; useSSE: boolean },
  elapsed: () => number,
  upstreamPin?: string,
): Promise<Response> {
  const { state, body, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const isStreaming = mode.kind === "stream"

  const target = translateGeminiToResponses(body, model)
  target.stream = isStreaming

  const binding = await resolveBinding(state, ctx.userId, model, "responses", upstreamPin)
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { message: `No responses upstream available for model: ${model}`, status: "NOT_FOUND" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream
  const upstreamTimer = startTimer()

  if (mode.kind === "stream") {
    const upstream = await withConnectionMismatchRetry(
      target as unknown as Record<string, unknown>,
      (p) =>
        provider.callResponses(p as Record<string, unknown>, {
          operationName: "gemini stream generate content (via responses)",
        }),
    )
    const upstreamMs = upstreamTimer()

    const pipe = mode.useSSE
      ? createResponsesToGeminiSSEStream()
      : createResponsesToGeminiJSONStream()
    const heartbeated = mode.useSSE
      ? wrapOpenAIHeartbeat(upstream.body)
      : upstream.body
    let pipeBody = heartbeated
    if (apiKeyId && pipeBody) {
      const [usageBranch, responseBranch] = pipeBody.tee()
      consumeStreamForUsage(usageBranch, apiKeyId, model, client, upstreamId)
      pipeBody = responseBranch
    }
    if (pipeBody) {
      pipeBody.pipeTo(pipe.writable).catch(() => {})
    }

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: true,
        sourceApi: "gemini",
        targetApi: "responses",
        upstream: upstreamId,
      }).catch(() => {})
    }

    return new Response(pipe.readable, {
      headers: mode.useSSE
        ? { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }
        : { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    })
  }

  let upstreamMs = 0
  const syncPromise: Promise<{
    respJson: Parameters<typeof translateResponsesToGeminiResponse>[0]
    gemini: GeminiGenerateContentResponse
  }> = (async () => {
    const upstream = await withConnectionMismatchRetry(
      target as unknown as Record<string, unknown>,
      (p) =>
        provider.callResponses(p as Record<string, unknown>, {
          operationName: "gemini generate content (via responses)",
        }),
    )
    upstreamMs = upstreamTimer()
    const respJson = (await upstream.json()) as Parameters<
      typeof translateResponsesToGeminiResponse
    >[0]
    return {
      respJson,
      gemini: translateResponsesToGeminiResponse(respJson, model),
    }
  })()

  const recordSync = async (v: { respJson: Parameters<typeof translateResponsesToGeminiResponse>[0]; gemini: GeminiGenerateContentResponse }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(v.respJson as unknown as Record<string, unknown>, apiKeyId, model, client, upstreamId)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: v.gemini.usageMetadata?.promptTokenCount,
      outputTokens: v.gemini.usageMetadata?.candidatesTokenCount,
      sourceApi: "gemini",
      targetApi: "responses",
      upstream: upstreamId,
    }).catch(() => {})
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
