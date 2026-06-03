import { getApiKeyById } from "~/lib/api-keys"
import { detectClient } from "~/lib/client-detect"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import { getRepo } from "~/repo"
import {
  hasWebSearch,
  interceptWebSearch,
  replayResponseAsSSE,
  runWebSearchLoop,
  streamTerminalCall,
  type ApiResponse,
  type LoopResult,
  type MessagesInterceptedSearch,
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

  const callOptions = {
    copilotToken: state.copilotToken,
    accountType: state.accountType,
  }
  const engineOptions = {
    langsearchKey: resolvedKeys.langsearchKey,
    tavilyKey: resolvedKeys.tavilyKey,
    githubToken: state.githubToken,
    msGroundingKey: resolvedKeys.msGroundingKey,
    priority: keyConfig.webSearchPriority,
  }

  // Streaming clients: run the loop (non-streaming upstream for tool rounds),
  // then re-issue the terminal turn with stream:true so the client sees real
  // per-token cadence from upstream. No replay, no synthetic pacing.
  if (wantsStream) {
    const upstreamTimer = startTimer()
    const loopPromise = runWebSearchLoop(interceptPayload, {
      ...callOptions,
      engineOptions,
    })
    return buildWebSearchStreamingResponse(
      ctx,
      payload,
      loopPromise,
      callOptions,
      upstreamTimer,
      elapsed,
      client,
    )
  }

  // Non-streaming: legacy path — loop to completion then return full JSON.
  const upstreamTimer = startTimer()
  const upstreamPromise = interceptWebSearch(interceptPayload, {
    ...callOptions,
    engineOptions,
  })

  const recordSideEffects = async (
    result: { response: unknown; meta: WebSearchMeta },
  ) => {
    const { response, meta } = result
    const upstreamMs = upstreamTimer()
    if (!apiKeyId) return
    await trackNonStreamingUsage(response, apiKeyId, payload.model, client, state.upstream)
    const usage = response as { usage?: { input_tokens?: number; output_tokens?: number } }
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: wantsStream,
      inputTokens: usage.usage?.input_tokens,
      outputTokens: usage.usage?.output_tokens,
      userAgent,
      sourceApi: "messages",
      targetApi: "messages",
      upstream: state.upstream,
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

  const raced = await raceWithHeartbeat(upstreamPromise, {
    serialize: (v) => JSON.stringify(v.response),
    onResolve: recordSideEffects,
  })

  if (raced.kind === "stream") {
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
 * Strip upstream's `message_start` event from a raw Anthropic SSE stream.
 * We've already emitted a synthetic one when the response opened (so the
 * client got first bytes immediately during the search loop) — letting
 * upstream's also through would break SDK accumulators that assume exactly
 * one message_start per stream.
 *
 * Works on frame boundaries (\n\n) which Anthropic guarantees per event.
 */
function stripUpstreamMessageStart(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let stripped = false
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      // Drain complete frames; keep partial tail in buffer.
      while (true) {
        const idx = buffer.indexOf("\n\n")
        if (idx === -1) break
        const frame = buffer.slice(0, idx + 2)
        buffer = buffer.slice(idx + 2)
        if (!stripped && frame.startsWith("event: message_start")) {
          stripped = true
          continue
        }
        controller.enqueue(encoder.encode(frame))
      }
    },
    flush(controller) {
      if (buffer.length > 0) controller.enqueue(encoder.encode(buffer))
    },
  })
}

/**
 * Streaming web-search response. Opens SSE immediately with a synthetic
 * message_start (dodges first-byte timeouts during the search loop), pings
 * periodically, then either:
 *   - terminal_required: opens a fresh streaming upstream call and pipes
 *     raw bytes (minus upstream's own message_start) directly to the client.
 *     Client sees real per-token cadence.
 *   - complete (early exit): falls back to the replay-with-pacing path.
 */
function buildWebSearchStreamingResponse(
  ctx: RouteContext,
  payload: AnthropicMessagesPayload,
  loopPromise: Promise<LoopResult>,
  callOptions: { copilotToken: string; accountType: import("~/config/constants").AccountType },
  upstreamTimer: () => number,
  elapsed: () => number,
  client: string | undefined,
): Response {
  const { state, apiKeyId, colo, requestId, userAgent } = ctx
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

  const recordSearchUsage = (meta: WebSearchMeta) => {
    if (!apiKeyId || meta.searchCount === 0) return
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

  const recordLatencyOnce = (upstreamMs: number, usage?: { input_tokens?: number; output_tokens?: number }) => {
    if (!apiKeyId) return
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: true,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      userAgent,
      sourceApi: "messages",
      targetApi: "messages",
      upstream: state.upstream,
    }).catch(() => {})
  }

  const emitSearchProgress = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    searches: MessagesInterceptedSearch[],
  ) => {
    for (const s of searches) {
      const frame =
        `event: web_search_progress\ndata: ${JSON.stringify({
          type: "web_search_progress",
          item_id: s.toolUseId,
          status: "completed",
          query: s.query,
          is_error: s.isError,
        })}\n\n`
      try { controller.enqueue(encoder.encode(frame)) } catch { /* ignore */ }
    }
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
        const result = await loopPromise
        recordSearchUsage(result.meta)
        emitSearchProgress(controller, result.searches)

        if (result.kind === "complete") {
          // Early exit (model returned non-web_search tool alongside). The
          // intercepted response IS the final turn — replay it with pacing,
          // there's no upstream turn left to stream from.
          console.log(JSON.stringify({
            evt: "ws_stream_complete_replay", rid: requestId,
            searchCount: result.meta.searchCount,
          }))
          const usage = (result.response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
          if (apiKeyId) {
            await trackNonStreamingUsage(result.response, apiKeyId, payload.model, client, state.upstream)
          }
          recordLatencyOnce(upstreamTimer(), usage)
          const sseBody = replayResponseAsSSE(result.response as ApiResponse, { skipMessageStart: true })
          const reader = sseBody.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value && value.length > 0) {
              try { controller.enqueue(value) } catch { break }
            }
          }
        } else {
          // Terminal turn re-issued with stream:true — pipe raw upstream bytes
          // straight to the client so per-token cadence is real (not synthesized).
          console.log(JSON.stringify({
            evt: "ws_stream_terminal_open", rid: requestId,
            searchCount: result.meta.searchCount,
          }))
          const upstreamBody = await streamTerminalCall(result, callOptions)
          const upstreamMs = upstreamTimer()
          // tee() so usage extractor reads its own copy without competing
          // with the forward branch.
          let forwardBranch = upstreamBody
          if (apiKeyId) {
            const [usageBranch, fwd] = upstreamBody.tee()
            forwardBranch = fwd
            const usagePromise = consumeStreamForUsage(usageBranch, apiKeyId, payload.model, client, state.upstream)
            ctx.executionCtx?.waitUntil(usagePromise)
          }
          recordLatencyOnce(upstreamMs)
          const filtered = forwardBranch.pipeThrough(stripUpstreamMessageStart())
          const reader = filtered.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value && value.length > 0) {
              try { controller.enqueue(value) } catch { break }
            }
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
  return new Response(stream, { headers })
}
