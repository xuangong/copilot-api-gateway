import { detectClient } from "~/lib/client-detect"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapAnthropicHeartbeat } from "~/lib/sse-heartbeat"
import { trackNonStreamingUsage } from "~/middleware/usage"
import { createCopilotProvider } from "~/providers/registry"
import { withConnectionMismatchRetry } from "~/services/copilot/connection-mismatch"
import {
  createResponsesToMessagesStream,
  translateMessagesToResponses,
  translateResponsesToMessagesResponse,
} from "~/translators/messages-via-responses"
import {
  disableResponsesReasoningOnForcedToolChoice,
  type AnthropicMessagesPayload,
  type ResponsesPayload,
} from "~/transforms"

import type { RouteContext } from "./utils"

/**
 * Responses-upstream fallback for /v1/messages: used when the chosen Copilot
 * model only serves /v1/responses (gpt-5.x). Translates Anthropic Messages →
 * Responses request, then unwinds the SSE/JSON answer back into Anthropic
 * Messages on the way out.
 */
export async function handleMessagesViaResponses(
  ctx: RouteContext,
  payload: AnthropicMessagesPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const model = payload.model
  const isStreaming = payload.stream !== false

  const responsesPayload = translateMessagesToResponses(payload)
  disableResponsesReasoningOnForcedToolChoice(
    responsesPayload as unknown as ResponsesPayload,
    state.enabledFlags ?? new Set(),
  )
  responsesPayload.stream = isStreaming

  const provider = createCopilotProvider({ copilotToken: state.copilotToken, accountType: state.accountType })
  const upstreamTimer = startTimer()

  if (isStreaming) {
    const upstream = await withConnectionMismatchRetry(
      responsesPayload as unknown as Record<string, unknown>,
      (p) => provider.callResponses(p as Record<string, unknown>, { operationName: "messages (via responses)" }),
    )
    const upstreamMs = upstreamTimer()

    // Pipe: upstream Responses bytes → translator (already frame-aware) →
    // Anthropic heartbeat wrapper for client-side keepalive.
    const translated = upstream.body?.pipeThrough(createResponsesToMessagesStream())
    const heartbeated = wrapAnthropicHeartbeat(translated ?? null)

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: true,
        sourceApi: "messages",
        targetApi: "responses",
        upstream: state.upstream,
      }).catch(() => {})
    }

    // Streaming usage extraction lives in middleware/usage and is wired
    // for native Anthropic SSE — since we produced the SSE ourselves above
    // and already know it terminates with message_delta + usage, defer
    // exact accounting to non-stream sync (which still goes through
    // trackNonStreamingUsage). For now, just stream.
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
      responsesPayload as unknown as Record<string, unknown>,
      (p) => provider.callResponses(p as Record<string, unknown>, { operationName: "messages (via responses)" }),
    )
    upstreamMs = upstreamTimer()
    const respJson = (await upstream.json()) as Parameters<typeof translateResponsesToMessagesResponse>[0]
    return { respJson, messagesJson: translateResponsesToMessagesResponse(respJson) }
  })()

  const recordSync = async ({
    messagesJson,
  }: { respJson: unknown; messagesJson: ReturnType<typeof translateResponsesToMessagesResponse> }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(messagesJson, apiKeyId, model, client, state.upstream)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: messagesJson.usage.input_tokens,
      outputTokens: messagesJson.usage.output_tokens,
      sourceApi: "messages",
      targetApi: "responses",
      upstream: state.upstream,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response
  await recordSync(raced.value)
  return new Response(JSON.stringify(raced.value.messagesJson), {
    headers: { "Content-Type": "application/json" },
  })
}
