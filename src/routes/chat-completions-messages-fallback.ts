/**
 * Messages-upstream fallback for /v1/chat/completions: used when the chosen
 * Copilot model only serves /v1/messages (claude-*). Translates Chat
 * Completions ↔ Messages on both request and response paths.
 */

import { detectClient } from "~/lib/client-detect"
import { resolveBinding, pinFromPayload } from "~/lib/binding-resolver"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import type { AppState } from "~/lib/state"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import type { ChatCompletionsPayload } from "~/services/gemini/format-conversion"
import { withConnectionMismatchRetry } from "~/services/copilot/connection-mismatch"
import {
  addWebSearchHeaders,
  hasOpenAIWebSearch,
  interceptWebSearch,
  loadWebSearchConfig,
  prepareOpenAIPayload,
  recordWebSearchUsage,
  replayChatCompletionAsSSE,
  type MessagesPayload,
  type OpenAIChatPayload,
  type OpenAIChatResponse,
} from "~/services/web-search"
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
  userId?: string
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

  // Normalize hosted {type:"web_search"} / web_search_preview to a function tool
  // before the request translator runs — translateChatCompletionsToMessages
  // assumes every tool has a `function` field and crashes otherwise.
  const normalizedPayload = hasOpenAIWebSearch(payload as unknown as OpenAIChatPayload)
    ? (prepareOpenAIPayload(payload as unknown as OpenAIChatPayload) as unknown as ChatCompletionsPayload)
    : payload

  const target = translateChatCompletionsToMessages(normalizedPayload)
  target.stream = isStreaming

  const binding = await resolveBinding(state, ctx.userId, model, "messages", pinFromPayload(payload as unknown as Record<string, unknown>))
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `No messages upstream available for model: ${model}. Run GET /v1/models for available ids.` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream
  const upstreamTimer = startTimer()

  // Web-search intercept: claude-* upstream does NOT execute web_search
  // natively, so we run the multi-turn loop here. Mirrors the OpenAI-protocol
  // intercept in chat-completions.ts:151 but on the Messages upstream.
  if (hasOpenAIWebSearch(payload as unknown as OpenAIChatPayload)) {
    const cfg = await loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)
    if (!cfg.enabled) return cfg.errorResponse!

    // The Chat→Messages translator already mapped function:web_search to a
    // client-tool with name="web_search"; interceptor matches by name.
    const interceptPayload: MessagesPayload = { ...(target as unknown as MessagesPayload), stream: false }
    const { response: messagesJson, meta, searches } = await interceptWebSearch(interceptPayload, {
      copilotToken: state.copilotToken,
      accountType: state.accountType,
      engineOptions: cfg.engineOptions!,
    })
    const upstreamMs = upstreamTimer()
    const chatJson = translateMessagesToChatCompletionsResponse(
      messagesJson as unknown as Parameters<typeof translateMessagesToChatCompletionsResponse>[0],
    )

    if (apiKeyId) {
      await trackNonStreamingUsage(messagesJson, apiKeyId, model, client, upstreamId)
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: isStreaming,
        inputTokens: chatJson.usage?.prompt_tokens,
        outputTokens: chatJson.usage?.completion_tokens,
        userAgent,
        sourceApi: "chat-completions",
        targetApi: "messages",
        upstream: upstreamId,
      }).catch(() => {})
      recordWebSearchUsage(apiKeyId, meta)
    }

    if (isStreaming) {
      const sseBody = replayChatCompletionAsSSE(
        chatJson as unknown as OpenAIChatResponse,
        searches.map((s) => ({
          query: s.query,
          content: "",
          toolCallId: s.toolUseId,
          isError: s.isError,
        })),
      )
      const heartbeated = wrapOpenAIHeartbeat(sseBody)
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      }
      addWebSearchHeaders(headers, meta)
      return new Response(heartbeated, { headers })
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    addWebSearchHeaders(headers, meta)
    return new Response(JSON.stringify(chatJson), { headers })
  }

  if (isStreaming) {
    const upstream = await withConnectionMismatchRetry(
      target as unknown as Record<string, unknown>,
      (p) =>
        provider.fetch(
          "messages",
          { method: "POST", body: JSON.stringify(p) },
          { operationName: "chat completions (via messages)", enabledFlags: binding.enabledFlags },
        ),
    )
    const upstreamMs = upstreamTimer()

    let translateBody = upstream.body
    if (apiKeyId && translateBody) {
      const [usageBranch, responseBranch] = translateBody.tee()
      consumeStreamForUsage(usageBranch, apiKeyId, model, client, upstreamId)
      translateBody = responseBranch
    }
    const translated = translateBody?.pipeThrough(
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
          upstream: upstreamId,
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
        provider.fetch(
          "messages",
          { method: "POST", body: JSON.stringify(p) },
          { operationName: "chat completions (via messages)", enabledFlags: binding.enabledFlags },
        ),
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
    await trackNonStreamingUsage(messagesJson, apiKeyId, model, client, upstreamId)
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
        upstream: upstreamId,
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
