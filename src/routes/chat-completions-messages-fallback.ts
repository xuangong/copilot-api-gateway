/**
 * Messages-upstream fallback for /v1/chat/completions: used when the chosen
 * Copilot model only serves /v1/messages (claude-*). Translates Chat
 * Completions ↔ Messages on both request and response paths.
 */

import { detectClient } from "~/lib/client-detect"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import type { AppState } from "~/lib/state"
import { trackNonStreamingUsage } from "~/middleware/usage"
import { createCopilotProvider } from "~/providers/registry"
import type { ChatCompletionsPayload } from "~/services/gemini/format-conversion"
import { withConnectionMismatchRetry } from "~/services/copilot/connection-mismatch"
import {
  createMessagesToChatCompletionsStream,
  translateChatCompletionsToMessages,
  translateMessagesToChatCompletionsResponse,
} from "~/translators/chat-completions-via-messages"

interface RouteContext {
  state: AppState
  body: ChatCompletionsPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
}

export async function handleChatCompletionsViaMessages(
  ctx: RouteContext,
  payload: ChatCompletionsPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const model = payload.model
  const isStreaming = payload.stream === true

  const target = translateChatCompletionsToMessages(payload)
  target.stream = isStreaming

  const provider = createCopilotProvider({
    copilotToken: state.copilotToken,
    accountType: state.accountType,
  })
  const upstreamTimer = startTimer()

  if (isStreaming) {
    const upstream = await withConnectionMismatchRetry(
      target as unknown as Record<string, unknown>,
      (p) =>
        provider.callMessages(p as Record<string, unknown>, {
          operationName: "chat completions (via messages)",
        }),
    )
    const upstreamMs = upstreamTimer()

    const translated = upstream.body?.pipeThrough(
      createMessagesToChatCompletionsStream(model),
    )
    const heartbeated = wrapOpenAIHeartbeat(translated ?? null)

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
        {
          stream: true,
          sourceApi: "chat-completions",
          targetApi: "messages",
          upstream: state.upstream,
        },
      ).catch(() => {})
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
      target as unknown as Record<string, unknown>,
      (p) =>
        provider.callMessages(p as Record<string, unknown>, {
          operationName: "chat completions (via messages)",
        }),
    )
    upstreamMs = upstreamTimer()
    const messagesJson = (await upstream.json()) as Parameters<
      typeof translateMessagesToChatCompletionsResponse
    >[0]
    return {
      messagesJson,
      chatJson: translateMessagesToChatCompletionsResponse(messagesJson),
    }
  })()

  const recordSync = async ({
    messagesJson,
    chatJson,
  }: {
    messagesJson: Parameters<typeof translateMessagesToChatCompletionsResponse>[0]
    chatJson: ReturnType<typeof translateMessagesToChatCompletionsResponse>
  }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(messagesJson, apiKeyId, model, client, state.upstream)
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
        inputTokens: chatJson.usage.prompt_tokens,
        outputTokens: chatJson.usage.completion_tokens,
        sourceApi: "chat-completions",
        targetApi: "messages",
        upstream: state.upstream,
      },
    ).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response
  await recordSync(raced.value)
  return new Response(JSON.stringify(raced.value.chatJson), {
    headers: { "Content-Type": "application/json" },
  })
}
