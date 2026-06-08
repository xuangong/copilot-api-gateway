import { detectClient } from "~/lib/client-detect"
import { resolveBinding, effectiveFlags, pinFromPayload } from "~/lib/binding-resolver"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapAnthropicHeartbeat } from "~/lib/sse-heartbeat"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import { withConnectionMismatchRetry } from "~/services/copilot/connection-mismatch"
import {
  createChatCompletionsToMessagesStream,
  translateMessagesToChatCompletions,
  translateChatCompletionsToMessagesResponse,
} from "~/translators/messages-via-chat-completions"
import {
  disableChatCompletionsReasoningOnForcedToolChoice,
  type AnthropicMessagesPayload,
} from "~/transforms"

import type { RouteContext } from "./utils"

/**
 * Chat-Completions-upstream fallback for /v1/messages: used when the chosen
 * Copilot model only serves /v1/chat/completions (gpt-* non-5.x). Translates
 * Anthropic Messages → Chat Completions request, then unwinds the SSE/JSON
 * answer back into Anthropic Messages on the way out.
 */
export async function handleMessagesViaChatCompletions(
  ctx: RouteContext,
  payload: AnthropicMessagesPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const model = payload.model
  const isStreaming = payload.stream !== false

  const chatPayload = translateMessagesToChatCompletions(payload)
  chatPayload.stream = isStreaming
  if (isStreaming) {
    chatPayload.stream_options = {
      ...(chatPayload.stream_options ?? {}),
      include_usage: true,
    }
  }

  const binding = await resolveBinding(state, ctx.userId, model, "chat_completions", pinFromPayload(payload as unknown as Record<string, unknown>))
  if (!binding) {
    return new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `No chat-completions upstream available for model: ${model}. Run GET /v1/models for available ids.` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream
  disableChatCompletionsReasoningOnForcedToolChoice(
    chatPayload as Parameters<typeof disableChatCompletionsReasoningOnForcedToolChoice>[0],
    effectiveFlags(state, binding),
  )
  const upstreamTimer = startTimer()

  if (isStreaming) {
    const upstream = await withConnectionMismatchRetry(
      chatPayload as unknown as Record<string, unknown>,
      (p) => provider.fetch(
        "chat_completions",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "messages (via chat completions)", enabledFlags: binding.enabledFlags },
      ),
    )
    const upstreamMs = upstreamTimer()

    let translateBody = upstream.body
    if (apiKeyId && translateBody) {
      const [usageBranch, responseBranch] = translateBody.tee()
      const usagePromise = consumeStreamForUsage(usageBranch, apiKeyId, model, client, upstreamId)
      ctx.executionCtx?.waitUntil(usagePromise)
      translateBody = responseBranch
    }
    const translated = translateBody?.pipeThrough(createChatCompletionsToMessagesStream(model))
    const heartbeated = wrapAnthropicHeartbeat(translated ?? null)

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: true,
        sourceApi: "messages",
        targetApi: "chat-completions",
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
      chatPayload as unknown as Record<string, unknown>,
      (p) => provider.fetch(
        "chat_completions",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "messages (via chat completions)", enabledFlags: binding.enabledFlags },
      ),
    )
    upstreamMs = upstreamTimer()
    const chatJson = (await upstream.json()) as Parameters<
      typeof translateChatCompletionsToMessagesResponse
    >[0]
    return {
      chatJson,
      messagesJson: translateChatCompletionsToMessagesResponse(chatJson, model),
    }
  })()

  const recordSync = async ({
    messagesJson,
  }: {
    chatJson: unknown
    messagesJson: ReturnType<typeof translateChatCompletionsToMessagesResponse>
  }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(messagesJson, apiKeyId, model, client, upstreamId)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: messagesJson.usage.input_tokens,
      outputTokens: messagesJson.usage.output_tokens,
      sourceApi: "messages",
      targetApi: "chat-completions",
      upstream: upstreamId,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response
  await recordSync(raced.value)
  return new Response(JSON.stringify(raced.value.messagesJson), {
    headers: { "Content-Type": "application/json" },
  })
}
