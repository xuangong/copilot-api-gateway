import { detectClient } from "~/lib/client-detect"
import { resolveBinding, effectiveFlags, pinFromPayload } from "~/lib/binding-resolver"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapAnthropicHeartbeat } from "~/lib/sse-heartbeat"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
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
  responsesPayload.stream = isStreaming

  const binding = await resolveBinding(state, ctx.userId, model, "responses", pinFromPayload(payload as unknown as Record<string, unknown>))
  if (!binding) {
    return new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `No responses upstream available for model: ${model}. Run GET /v1/models for available ids.` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream
  disableResponsesReasoningOnForcedToolChoice(
    responsesPayload as unknown as ResponsesPayload,
    effectiveFlags(state, binding),
  )
  const upstreamTimer = startTimer()

  if (isStreaming) {
    const upstream = await withConnectionMismatchRetry(
      responsesPayload as unknown as Record<string, unknown>,
      (p) => provider.fetch(
        "responses",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "messages (via responses)", sourceApi: "messages", enabledFlags: binding.enabledFlags },
      ),
    )
    const upstreamMs = upstreamTimer()

    let translateBody = upstream.body
    if (apiKeyId && translateBody) {
      const [usageBranch, responseBranch] = translateBody.tee()
      consumeStreamForUsage(usageBranch, apiKeyId, model, client, upstreamId)
      translateBody = responseBranch
    }

    const translated = translateBody?.pipeThrough(createResponsesToMessagesStream())
    const heartbeated = wrapAnthropicHeartbeat(translated ?? null)

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: true,
        sourceApi: "messages",
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
      responsesPayload as unknown as Record<string, unknown>,
      (p) => provider.fetch(
        "responses",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "messages (via responses)", sourceApi: "messages", enabledFlags: binding.enabledFlags },
      ),
    )
    upstreamMs = upstreamTimer()
    const respJson = (await upstream.json()) as Parameters<typeof translateResponsesToMessagesResponse>[0]
    return { respJson, messagesJson: translateResponsesToMessagesResponse(respJson) }
  })()

  const recordSync = async ({
    messagesJson,
  }: { respJson: unknown; messagesJson: ReturnType<typeof translateResponsesToMessagesResponse> }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(messagesJson, apiKeyId, model, client, upstreamId)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: messagesJson.usage.input_tokens,
      outputTokens: messagesJson.usage.output_tokens,
      sourceApi: "messages",
      targetApi: "responses",
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
