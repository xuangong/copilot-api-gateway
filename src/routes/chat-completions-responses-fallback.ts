import { detectClient } from "~/lib/client-detect"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import { trackNonStreamingUsage } from "~/middleware/usage"
import { createCopilotProvider } from "~/providers/registry"
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

  const provider = createCopilotProvider({ copilotToken: state.copilotToken, accountType: state.accountType })
  const upstreamTimer = startTimer()

  if (isStreaming) {
    const upstream = await withConnectionMismatchRetry(
      respPayload as unknown as Record<string, unknown>,
      (p) => provider.callResponses(p as Record<string, unknown>, {
        operationName: "chat completions (via responses)",
      }),
    )
    const upstreamMs = upstreamTimer()

    const translated = upstream.body?.pipeThrough(createResponsesToChatCompletionsStream(model))
    const heartbeated = wrapOpenAIHeartbeat(translated ?? null)

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: true,
        sourceApi: "chat-completions",
        targetApi: "responses",
        upstream: state.upstream,
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
      (p) => provider.callResponses(p as Record<string, unknown>, {
        operationName: "chat completions (via responses)",
      }),
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
    await trackNonStreamingUsage(chatJson, apiKeyId, model, client, state.upstream)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: chatJson.usage?.prompt_tokens,
      outputTokens: chatJson.usage?.completion_tokens,
      sourceApi: "chat-completions",
      targetApi: "responses",
      upstream: state.upstream,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response
  await recordSync(raced.value)
  return new Response(JSON.stringify(raced.value.chatJson), {
    headers: { "Content-Type": "application/json" },
  })
}
