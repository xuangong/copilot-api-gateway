import { detectClient } from "~/lib/client-detect"
import { resolveBinding, pinFromPayload } from "~/lib/binding-resolver"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapAnthropicHeartbeat } from "~/lib/sse-heartbeat"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
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
  const binding = await resolveBinding(state, ctx.userId, payload.model, "messages", pinFromPayload(payload as unknown as Record<string, unknown>))
  if (!binding) {
    return new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `No messages upstream available for model: ${payload.model}` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream

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
    let responseBody = response.body
    if (apiKeyId && responseBody) {
      // tee() so usage extraction reads its own copy without competing with
      // the heartbeat-wrapped forward branch. waitUntil keeps the usage
      // consumer alive after the Response is returned — on CFW any bare
      // background promise the runtime doesn't observe is killed when the
      // isolate winds down, which is what silently lost streaming usage
      // before this fix.
      const [usageBranch, forwardBranch] = responseBody.tee()
      const usagePromise = consumeStreamForUsage(usageBranch, apiKeyId, payload.model, client, upstreamId)
      ctx.executionCtx?.waitUntil(usagePromise)
      responseBody = forwardBranch
    }
    let heartbeated = wrapAnthropicHeartbeat(responseBody)
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
      }, requestId, { stream: true, sourceApi: "messages", targetApi: "messages", upstream: upstreamId }).catch((e) => console.error('[latency] record error:', e))
    }
    return streamResponse
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
    await trackNonStreamingUsage(j, apiKeyId, payload.model, client, upstreamId)
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: j.usage?.input_tokens,
      outputTokens: j.usage?.output_tokens,
      userAgent,
      sourceApi: "messages",
      targetApi: "messages",
      upstream: upstreamId,
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
