import { getApiKeyById } from "~/lib/api-keys"
import { detectClient } from "~/lib/client-detect"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapAnthropicHeartbeat } from "~/lib/sse-heartbeat"
import { trackNonStreamingUsage } from "~/middleware/usage"
import { getRepo } from "~/repo"
import {
  hasWebSearch,
  interceptWebSearch,
  replayResponseAsSSE,
  type ApiResponse,
  type MessagesPayload,
  type WebSearchMeta,
} from "~/services/web-search"
import { resolveWebSearchKeys } from "~/services/web-search/resolver"
import type { AnthropicMessagesPayload } from "~/transforms"

import { addWebSearchHeaders, type RouteContext } from "./utils"

export { hasWebSearch }

/**
 * Web-search intercept loop: always runs upstream in non-streaming mode so we
 * have the full assistant response in hand (needed to execute tool calls and
 * replay back to the client). Handles streaming + non-streaming clients.
 *
 * Returns `null` if web search is configured but disabled for this key —
 * caller should return that error response directly.
 */
export async function handleWebSearch(
  ctx: RouteContext,
  payload: AnthropicMessagesPayload,
  messagesPayload: MessagesPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
  const client = detectClient(userAgent)

  const keyConfig = apiKeyId ? await getApiKeyById(apiKeyId) : null
  if (!keyConfig?.webSearchEnabled) {
    return new Response(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "Web search is not enabled for this API key. Configure it in the dashboard.",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  const wantsStream = payload.stream === true
  const interceptPayload: MessagesPayload = { ...messagesPayload, stream: false }
  const resolvedKeys = await resolveWebSearchKeys(keyConfig, state.msGroundingKey)

  const upstreamTimer = startTimer()
  const upstreamPromise = interceptWebSearch(interceptPayload, {
    copilotToken: state.copilotToken,
    accountType: state.accountType,
    engineOptions: {
      langsearchKey: resolvedKeys.langsearchKey,
      tavilyKey: resolvedKeys.tavilyKey,
      githubToken: state.githubToken,
      msGroundingKey: resolvedKeys.msGroundingKey,
      priority: keyConfig.webSearchPriority,
    },
  })

  const recordSideEffects = async (
    result: { response: unknown; meta: WebSearchMeta },
  ) => {
    const { response, meta } = result
    const upstreamMs = upstreamTimer()
    if (!apiKeyId) return
    await trackNonStreamingUsage(response, apiKeyId, payload.model, client)
    const usage = response as { usage?: { input_tokens?: number; output_tokens?: number } }
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: wantsStream,
      inputTokens: usage.usage?.input_tokens,
      outputTokens: usage.usage?.output_tokens,
      userAgent,
    }).catch(() => {})

    if (meta.searchCount > 0) {
      const hour = new Date().toISOString().slice(0, 13)
      const repo = getRepo()
      for (let i = 0; i < meta.successes; i++) {
        repo.webSearchUsage.record(apiKeyId, hour, true).catch(() => {})
      }
      for (let i = 0; i < meta.failures; i++) {
        repo.webSearchUsage.record(apiKeyId, hour, false).catch(() => {})
      }
      for (const a of meta.engineAttempts) {
        repo.webSearchEngineUsage
          .record(apiKeyId, a.engineId, hour, {
            ok: a.ok, resultCount: a.resultCount, durationMs: a.durationMs,
          })
          .catch(() => {})
      }
    }
  }

  if (wantsStream) {
    return buildWebSearchStreamingResponse(payload, upstreamPromise, requestId, recordSideEffects)
  }

  const raced = await raceWithHeartbeat(upstreamPromise, {
    serialize: (v) => JSON.stringify(v.response),
    onResolve: recordSideEffects,
  })

  if (raced.kind === "stream") {
    // Headers (incl. X-Web-Search-*) are locked once streaming starts; we omit
    // them on the slow path. Caller can still inspect response body.
    return raced.response
  }

  const { response, meta } = raced.value
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  addWebSearchHeaders(headers, meta)
  const wsResponse = new Response(JSON.stringify(response), { headers })
  await recordSideEffects(raced.value)
  return wsResponse
}

/**
 * Streaming client needs immediate bytes to dodge first-byte timeouts (e.g.
 * the PowerPoint Claude plugin closes after ~14s of silence). We open the SSE
 * stream with a synthetic message_start so the client sees a real protocol
 * event right away, ping periodically while the upstream web_search loop
 * runs, then append the replayed message frames once it resolves.
 */
function buildWebSearchStreamingResponse(
  payload: AnthropicMessagesPayload,
  upstreamPromise: Promise<{ response: unknown; meta: WebSearchMeta }>,
  requestId: string | undefined,
  recordSideEffects: (r: { response: unknown; meta: WebSearchMeta }) => Promise<void>,
): Response {
  const encoder = new TextEncoder()
  const PING = encoder.encode("event: ping\ndata: {}\n\n")
  const PING_INTERVAL_MS = 5000

  const synthMessageId = `msg_synth_${Date.now().toString(36)}`
  const synthStart = encoder.encode(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: synthMessageId,
        type: "message",
        role: "assistant",
        model: payload.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`,
  )
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try { controller.enqueue(synthStart) } catch { /* ignore */ }
      let closed = false
      const ping = setInterval(() => {
        if (closed) return
        try { controller.enqueue(PING) } catch { /* ignore */ }
      }, PING_INTERVAL_MS)
      const stopPing = () => { closed = true; clearInterval(ping) }

      try {
        const { response, meta } = await upstreamPromise
        console.log(JSON.stringify({
          evt: "ws_stream_replay_start",
          rid: requestId,
          searchCount: meta.searchCount,
        }))
        const sseBody = replayResponseAsSSE(response as ApiResponse, { skipMessageStart: true })
        const wrapped = wrapAnthropicHeartbeat(sseBody)
        const reader = wrapped!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.length > 0) {
            try { controller.enqueue(value) } catch { /* downstream gone */ break }
          }
        }
        stopPing()
        try { controller.close() } catch { /* ignore */ }
      } catch (err) {
        stopPing()
        console.error("[ws-stream] upstream error", err)
        try {
          const msg = err instanceof Error ? err.message : String(err)
          const errFrame =
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "api_error", message: msg },
            })}\n\n`
          controller.enqueue(encoder.encode(errFrame))
        } catch { /* ignore */ }
        try { controller.close() } catch { /* ignore */ }
      }
    },
  })
  const streamResponse = new Response(stream, { headers })
  upstreamPromise.then((v) => recordSideEffects(v)).catch(() => {})
  return streamResponse
}
