import { detectClient } from "~/lib/client-detect"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapAnthropicHeartbeat } from "~/lib/sse-heartbeat"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { createCopilotProvider } from "~/providers/registry"
import { omitThinkingFromAnthropicSse } from "~/lib/anthropic-sse-thinking-strip"
import type { AnthropicMessagesPayload } from "~/transforms"

import {
  SYNC_REQUEST_TIMEOUT_MS,
  type RouteContext,
} from "./utils"

/**
 * Direct /v1/messages passthrough with heartbeats. Two paths:
 *   - Streaming: wrap upstream body in anthropic heartbeat; optionally strip
 *     thinking_delta when display was promoted upstream.
 *   - Non-streaming: race upstream JSON with heartbeat to keep socket alive
 *     past the ~60s first-byte cutoff some clients/proxies enforce.
 */
export async function handleDirectMessages(
  ctx: RouteContext,
  payload: AnthropicMessagesPayload,
  passthroughHeaders: Record<string, string>,
  promotedThinking: boolean,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)
  const upstreamTimer = startTimer()
  const isStreaming = payload.stream === true
  const provider = createCopilotProvider({ copilotToken: state.copilotToken, accountType: state.accountType })

  if (isStreaming) {
    const response = await provider.callMessages(
      payload as unknown as Record<string, unknown>,
      { operationName: "create message", extraHeaders: passthroughHeaders },
    )
    const upstreamMs = upstreamTimer()

    // Wrap upstream body in idle-heartbeat stream so we never go 60s without
    // writing a byte — that's where client SDK read-timeouts and intermediate
    // proxies start cutting us off. Anthropic's "event: ping" is the
    // protocol-noop here; SDKs already filter it out as keepalive.
    let heartbeated = wrapAnthropicHeartbeat(response.body)
    // If we promoted thinking.display to "summarized" upstream, strip the
    // resulting thinking_delta events so the client sees the omitted
    // semantics it asked for (final signature preserved). Runs AFTER the
    // heartbeat wrapper, which guarantees frame-aligned chunks.
    if (promotedThinking && heartbeated) {
      heartbeated = heartbeated.pipeThrough(omitThinkingFromAnthropicSse())
    }
    const streamResponse = new Response(heartbeated, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
    if (apiKeyId) {
      recordLatency(apiKeyId, payload.model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, { stream: true }).catch((e) => console.error('[latency] record error:', e))
    }
    return apiKeyId
      ? trackStreamingUsage(streamResponse, apiKeyId, payload.model, client)
      : streamResponse
  }

  type SyncJson = { usage?: { input_tokens?: number; output_tokens?: number } }
  let upstreamMs = 0
  const syncPromise: Promise<SyncJson> = (async () => {
    const response = await provider.callMessages(
      payload as unknown as Record<string, unknown>,
      {
        operationName: "create message",
        timeout: SYNC_REQUEST_TIMEOUT_MS,
        extraHeaders: passthroughHeaders,
      },
    )
    upstreamMs = upstreamTimer()
    return (await response.json()) as SyncJson
  })()

  const recordSync = async (j: SyncJson) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(j, apiKeyId, payload.model, client)
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: j.usage?.input_tokens,
      outputTokens: j.usage?.output_tokens,
      userAgent,
    }).catch((e) => console.error('[latency] record error:', e))
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response

  const j = raced.value
  const jsonResponse = new Response(JSON.stringify(j), {
    headers: { "Content-Type": "application/json" },
  })
  await recordSync(j)
  return jsonResponse
}
