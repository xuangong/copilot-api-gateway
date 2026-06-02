import { detectClient } from "~/lib/client-detect"
import { resolveBinding, pinFromPayload } from "~/lib/binding-resolver"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import { withConnectionMismatchRetry } from "~/services/copilot/connection-mismatch"
import {
  createResponsesToChatCompletionsStream,
  translateChatCompletionsToResponsesRequest,
  translateResponsesToChatCompletionsResponse,
  type ResponsesResultLike,
} from "~/translators/chat-completions-via-responses"

import type { AppState } from "~/lib/state"

interface ChatPayload {
  model: string
  messages: unknown[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  [key: string]: unknown
}

interface RouteContext {
  state: AppState
  body: ChatPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  userId?: string
}

/**
 * Responses-upstream fallback for /v1/chat/completions: used when the chosen
 * Copilot model only serves /v1/responses (gpt-5.x). Translates Chat
 * Completions → Responses request, then unwinds the SSE/JSON response back
 * into Chat Completions on the way out.
 */
export async function handleChatCompletionsViaResponses(
  ctx: RouteContext,
  payload: ChatPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const model = payload.model
  const isStreaming = payload.stream === true

  const respPayload = translateChatCompletionsToResponsesRequest(
    payload as unknown as Parameters<typeof translateChatCompletionsToResponsesRequest>[0],
  )
  respPayload.stream = isStreaming

  const binding = await resolveBinding(state, ctx.userId, model, "responses", pinFromPayload(payload as unknown as Record<string, unknown>))
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `No responses upstream available for model: ${model}. Run GET /v1/models for available ids.` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream
  const upstreamTimer = startTimer()

  if (isStreaming) {
    const upstream = await withConnectionMismatchRetry(
      respPayload as unknown as Record<string, unknown>,
      (p) => provider.fetch(
        "responses",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "chat completions (via responses)", sourceApi: "chat_completions" },
      ),
    )
    const upstreamMs = upstreamTimer()

    let translateBody = upstream.body
    if (apiKeyId && translateBody) {
      const [usageBranch, responseBranch] = translateBody.tee()
      consumeStreamForUsage(usageBranch, apiKeyId, model, client, upstreamId)
      translateBody = responseBranch
    }
    const translated = translateBody?.pipeThrough(createResponsesToChatCompletionsStream(model))
    const heartbeated = wrapOpenAIHeartbeat(translated ?? null)

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: true,
        sourceApi: "chat-completions",
        targetApi: "responses",
        upstream: upstreamId,
      }).catch(() => {})
    }

    return new Response(heartbeated, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  let upstreamMs = 0
  const syncPromise = (async () => {
    const upstream = await withConnectionMismatchRetry(
      respPayload as unknown as Record<string, unknown>,
      (p) => provider.fetch(
        "responses",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "chat completions (via responses)", sourceApi: "chat_completions" },
      ),
    )
    upstreamMs = upstreamTimer()
    const respJson = (await upstream.json()) as ResponsesResultLike
    return {
      respJson,
      chatJson: translateResponsesToChatCompletionsResponse(respJson, model),
    }
  })()

  const recordSync = async ({
    chatJson,
  }: {
    respJson: ResponsesResultLike
    chatJson: ReturnType<typeof translateResponsesToChatCompletionsResponse>
  }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(chatJson, apiKeyId, model, client, upstreamId)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: chatJson.usage?.prompt_tokens,
      outputTokens: chatJson.usage?.completion_tokens,
      sourceApi: "chat-completions",
      targetApi: "responses",
      upstream: upstreamId,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response
  await recordSync(raced.value)
  return new Response(JSON.stringify(raced.value.chatJson), {
    headers: { "Content-Type": "application/json" },
  })
}
