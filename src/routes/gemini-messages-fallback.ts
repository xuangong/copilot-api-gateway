/**
 * Messages-upstream fallback for /v1beta/models/:model:generateContent
 * (and streamGenerateContent). Used when the requested Gemini model
 * resolves to a Claude upstream that only serves /v1/messages.
 *
 * Translates Gemini → Messages on the request path, and Messages SSE/JSON
 * → Gemini SSE/JSON on the response path via the gemini-via-messages
 * composition translator.
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
  createMessagesToGeminiJSONStream,
  createMessagesToGeminiSSEStream,
  translateGeminiToMessages,
  translateMessagesToGeminiResponse,
} from "~/translators/gemini-via-messages"

interface RouteContext {
  state: AppState
  body: GeminiGenerateContentRequest
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  userId?: string
}

export async function handleGeminiViaMessages(
  ctx: RouteContext,
  model: string,
  mode: { kind: "sync" } | { kind: "stream"; useSSE: boolean },
  elapsed: () => number,
  upstreamPin?: string,
): Promise<Response> {
  const { state, body, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const isStreaming = mode.kind === "stream"

  const target = translateGeminiToMessages(body, model)
  target.stream = isStreaming

  const binding = await resolveBinding(state, ctx.userId, model, "messages", upstreamPin)
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { message: `No messages upstream available for model: ${model}. Run GET /v1/models for available ids.`, status: "NOT_FOUND" } }),
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
        provider.fetch(
          "messages",
          { method: "POST", body: JSON.stringify(p) },
          { operationName: "gemini stream generate content (via messages)", enabledFlags: binding.enabledFlags },
        ),
    )
    const upstreamMs = upstreamTimer()

    const pipe = mode.useSSE
      ? createMessagesToGeminiSSEStream(model)
      : createMessagesToGeminiJSONStream(model)
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
        targetApi: "messages",
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
    messagesJson: Parameters<typeof translateMessagesToGeminiResponse>[0]
    gemini: GeminiGenerateContentResponse
  }> = (async () => {
    const upstream = await withConnectionMismatchRetry(
      target as unknown as Record<string, unknown>,
      (p) =>
        provider.fetch(
          "messages",
          { method: "POST", body: JSON.stringify(p) },
          { operationName: "gemini generate content (via messages)", enabledFlags: binding.enabledFlags },
        ),
    )
    upstreamMs = upstreamTimer()
    const messagesJson = (await upstream.json()) as Parameters<
      typeof translateMessagesToGeminiResponse
    >[0]
    return {
      messagesJson,
      gemini: translateMessagesToGeminiResponse(messagesJson, model),
    }
  })()

  const recordSync = async (v: { messagesJson: Parameters<typeof translateMessagesToGeminiResponse>[0]; gemini: GeminiGenerateContentResponse }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(v.messagesJson, apiKeyId, model, client, upstreamId)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: v.gemini.usageMetadata?.promptTokenCount,
      outputTokens: v.gemini.usageMetadata?.candidatesTokenCount,
      sourceApi: "gemini",
      targetApi: "messages",
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
