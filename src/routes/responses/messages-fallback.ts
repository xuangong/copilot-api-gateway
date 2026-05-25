import { detectClient } from "~/lib/client-detect"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import { createCopilotProvider } from "~/providers/registry"
import { withConnectionMismatchRetry } from "~/services/copilot/connection-mismatch"
import {
  createMessagesToResponsesStream,
  translateMessagesToResponsesResponse,
  translateResponsesToMessages,
} from "~/translators/responses-via-messages"
import type { ResponsesPayload } from "~/transforms"

import type { RouteContext } from "./utils"

/**
 * Messages-upstream fallback for /v1/responses: used when the chosen Copilot
 * model only serves /v1/messages (claude-*). Translates Responses ↔ Messages
 * on both request and response paths.
 */
export async function handleResponsesViaMessages(
  ctx: RouteContext,
  payload: ResponsesPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const model = payload.model
  const isStreaming = payload.stream === true

  const { target } = translateResponsesToMessages(payload)
  target.stream = isStreaming

  const provider = createCopilotProvider({
    copilotToken: state.copilotToken,
    accountType: state.accountType,
  })
  const upstreamTimer = startTimer()

  if (isStreaming) {
    const upstream = await withConnectionMismatchRetry(
      target as unknown as Record<string, unknown>,
      (p) => provider.callMessages(p as Record<string, unknown>, { operationName: "responses (via messages)" }),
    )
    const upstreamMs = upstreamTimer()

    let translateBody = upstream.body
    if (apiKeyId && translateBody) {
      const [usageBranch, responseBranch] = translateBody.tee()
      consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
      translateBody = responseBranch
    }
    const translated = translateBody?.pipeThrough(createMessagesToResponsesStream(model))
    const heartbeated = wrapOpenAIHeartbeat(translated ?? null)

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: true,
        sourceApi: "responses",
        targetApi: "messages",
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
      target as unknown as Record<string, unknown>,
      (p) => provider.callMessages(p as Record<string, unknown>, { operationName: "responses (via messages)" }),
    )
    upstreamMs = upstreamTimer()
    const messagesJson = (await upstream.json()) as Parameters<typeof translateMessagesToResponsesResponse>[0]
    return { messagesJson, responsesJson: translateMessagesToResponsesResponse(messagesJson) }
  })()

  const recordSync = async ({
    messagesJson,
    responsesJson,
  }: {
    messagesJson: Parameters<typeof translateMessagesToResponsesResponse>[0]
    responsesJson: ReturnType<typeof translateMessagesToResponsesResponse>
  }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(messagesJson, apiKeyId, model, client, state.upstream)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: responsesJson.usage.input_tokens,
      outputTokens: responsesJson.usage.output_tokens,
      sourceApi: "responses",
      targetApi: "messages",
      upstream: state.upstream,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response
  await recordSync(raced.value)
  return new Response(JSON.stringify(raced.value.responsesJson), {
    headers: { "Content-Type": "application/json" },
  })
}
