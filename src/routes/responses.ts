import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { callCopilotAPI } from "~/services/copilot"
import {
  fixApplyPatchTools,
  stripWebSearchTools,
  type ResponsesPayload,
} from "~/transforms"
import {
  translateResponsesToChatCompletions,
  translateChatCompletionsToResponses,
  translateChunkToResponsesEvents,
  createStreamState,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
} from "~/services/responses"
import { trackNonStreamingUsage, trackStreamingUsage, consumeStreamForUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { createSSETransform } from "~/lib/sse-transform"
import { detectClient } from "~/lib/client-detect"
import { checkQuota } from "~/lib/quota"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import {
  hasResponsesWebSearch,
  interceptResponsesViaChat,
  loadWebSearchConfig,
  addWebSearchHeaders,
  recordWebSearchUsage,
  synthChatCompletionChunks,
  type WebSearchMeta,
} from "~/services/web-search"

interface RouteContext {
  state: AppState
  body: ResponsesPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
}

/**
 * Determine whether to use /v1/responses (direct) or /chat/completions (conversion).
 *
 * Strategy: only gpt-5.x series support /v1/responses natively.
 * All older models (gpt-4.x, gpt-4o, gpt-4, gpt-3.x) use /chat/completions.
 */
function shouldUseChatFallback(model: string): boolean {
  // gpt-5.x and variants (gpt-5.1, gpt-5.2, gpt-5.3-codex, gpt-5.4, etc.) — responses native
  if (model.startsWith("gpt-5")) return false
  // Everything else — chat fallback
  return true
}

/**
 * Count completed `web_search_call` items in a non-streaming Responses
 * payload. Used to populate X-Web-Search-* headers on the gpt-5.x direct
 * path where Copilot executes the search natively.
 */
function countNativeWebSearchFromOutput(
  output: Array<{ type?: string; status?: string }> | undefined,
): WebSearchMeta {
  const meta: WebSearchMeta = {
    searchCount: 0,
    totalResults: 0,
    enginesUsed: [],
    successes: 0,
    failures: 0,
  }
  if (!Array.isArray(output)) return meta
  for (const item of output) {
    if (item?.type !== "web_search_call") continue
    meta.searchCount++
    if (item.status === "completed") {
      meta.successes++
    } else {
      meta.failures++
    }
  }
  if (meta.searchCount > 0 && !meta.enginesUsed.includes("copilot-native")) {
    meta.enginesUsed.push("copilot-native")
  }
  return meta
}

/**
 * Drain a teed copy of the Responses SSE stream and count native
 * web_search_call items emitted via response.output_item.done events.
 * Returns the assembled meta after the stream ends.
 */
async function countNativeWebSearchFromSSE(
  stream: ReadableStream<Uint8Array>,
): Promise<WebSearchMeta> {
  const meta: WebSearchMeta = {
    searchCount: 0,
    totalResults: 0,
    enginesUsed: [],
    successes: 0,
    failures: 0,
  }
  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (!data || data === "[DONE]") continue
        try {
          const evt = JSON.parse(data) as {
            type?: string
            item?: { type?: string; status?: string }
          }
          if (
            evt.type === "response.output_item.done" &&
            evt.item?.type === "web_search_call"
          ) {
            meta.searchCount++
            if (evt.item.status === "completed") {
              meta.successes++
            } else {
              meta.failures++
            }
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (meta.searchCount > 0 && !meta.enginesUsed.includes("copilot-native")) {
    meta.enginesUsed.push("copilot-native")
  }
  return meta
}

/**
 * Build a TransformStream that converts Chat Completions SSE → Responses SSE
 */
function buildStreamTransform(
  payload: ResponsesPayload,
  model: string,
): TransformStream<Uint8Array, Uint8Array> {
  const streamState = createStreamState(model)
  const encoder = new TextEncoder()

  return createSSETransform((data) => {
    try {
      const chatChunk = JSON.parse(data) as ChatCompletionChunk
      const events = translateChunkToResponsesEvents(chatChunk, streamState, payload)

      if (events.length > 0) {
        const parts: string[] = []
        for (const event of events) {
          parts.push(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
        }
        return encoder.encode(parts.join(""))
      }
    } catch {
      // Skip invalid JSON chunks
    }
    return null
  })
}

const handleResponses = async (ctx: unknown) => {
  const { state, body, apiKeyId, colo, requestId, userAgent } = ctx as unknown as RouteContext
  const elapsed = startTimer()
  const client = detectClient(userAgent)

  // Quota enforcement
  if (apiKeyId) {
    const quota = await checkQuota(apiKeyId)
    if (!quota.allowed) {
      return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }), { status: 429, headers: { "Content-Type": "application/json" } })
    }
  }

  const payload: ResponsesPayload = { ...(body as ResponsesPayload) }

  // Apply compatibility transforms
  fixApplyPatchTools(payload)

  const model = payload.model
  const useChatFallback = shouldUseChatFallback(model)
  const wantsWebSearch = hasResponsesWebSearch(payload)

  // ── Web-search interception ──────────────────────────────────────────
  // Two routes:
  //  - Chat-fallback (gpt-4.x etc.): upstream doesn't support web_search,
  //    convert to function tool and run intercept loop via chat.
  //  - gpt-5.x direct: Copilot's /v1/responses natively executes
  //    web_search/web_search_preview, returning web_search_call items
  //    with grounded text. We pass through and only meter the result.
  if (wantsWebSearch && useChatFallback) {
    const cfg = await loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)
    if (!cfg.enabled) return cfg.errorResponse!

    const upstreamTimer = startTimer()
    const { responsesResult, chatResponse, meta } = await interceptResponsesViaChat(
      payload,
      {
        copilotToken: state.copilotToken,
        accountType: state.accountType,
        engineOptions: cfg.engineOptions!,
      },
    )
    const upstreamMs = upstreamTimer()

    const recordSide = async () => {
      if (!apiKeyId) return
      await trackNonStreamingUsage(chatResponse, apiKeyId, model, client)
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: payload.stream === true,
        inputTokens: responsesResult.usage.input_tokens,
        outputTokens: responsesResult.usage.output_tokens,
        userAgent,
      }).catch(() => {})
      recordWebSearchUsage(apiKeyId, meta)
    }

    if (payload.stream === true) {
      // Synthesize a single ChatCompletionChunk + DONE and reuse the
      // existing Chat→Responses event transform pipeline.
      const synthesized = synthChatCompletionChunks(chatResponse)
      const heartbeated = wrapOpenAIHeartbeat(synthesized)
      const transformed = heartbeated?.pipeThrough(buildStreamTransform(payload, model))
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      }
      addWebSearchHeaders(headers, meta)
      const streamResponse = new Response(transformed, { headers })
      await recordSide()
      return streamResponse
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    addWebSearchHeaders(headers, meta)
    const jsonResponse = new Response(JSON.stringify(responsesResult), { headers })
    await recordSide()
    return jsonResponse
  }

  // For chat-fallback path that didn't carry web_search (or whose key isn't
  // authorised), strip any leftover web_search tool so upstream sees a clean list.
  // gpt-5.x direct path keeps web_search/web_search_preview because Copilot
  // executes them natively.
  if (payload.tools && useChatFallback) {
    payload.tools = stripWebSearchTools(payload.tools)
  }

  // gpt-5.x direct path with web_search: enforce key-level web_search permission
  // (parity with chat-fallback). On non-enabled keys, return the same 400 the
  // intercept path would have returned.
  let directWebSearchEnabled = false
  if (wantsWebSearch && !useChatFallback) {
    const cfg = await loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)
    if (!cfg.enabled) return cfg.errorResponse!
    directWebSearchEnabled = true
  }

  if (!useChatFallback) {
    // ── Direct passthrough to /v1/responses ──
    const upstreamTimer = startTimer()

    if (payload.stream === true) {
      const response = await callCopilotAPI({
        endpoint: "/v1/responses",
        payload: payload as unknown as Record<string, unknown>,
        operationName: "responses",
        copilotToken: state.copilotToken,
        accountType: state.accountType,
      })
      const upstreamMs = upstreamTimer()
      // Inject SSE comment heartbeats during long thinking gaps so CF edge
      // doesn't close the idle connection. ":" prefix = SSE comment line,
      // ignored by every spec-compliant SSE parser including the OpenAI SDK.
      const heartbeated = wrapOpenAIHeartbeat(response.body)
      const directHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      }

      // Native web_search metering: tap the SSE to count completed
      // web_search_call items as they appear in response.output_item.done
      // events. Headers are sent before the body in HTTP/1.1 so the count
      // can't be added retroactively — instead emit telemetry async.
      let bodyToReturn = heartbeated
      if (directWebSearchEnabled && heartbeated) {
        const [tap, forward] = heartbeated.tee()
        bodyToReturn = forward
        countNativeWebSearchFromSSE(tap)
          .then((meta) => recordWebSearchUsage(apiKeyId, meta))
          .catch(() => {})
        directHeaders["X-Web-Search-Engines"] = "copilot-native"
      }

      const streamResponse = new Response(bodyToReturn, { headers: directHeaders })
      if (apiKeyId) {
        recordLatency(apiKeyId, model, colo, {
          totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
        }, requestId, { stream: true }).catch(() => {})
      }
      return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, model, client) : streamResponse
    }

    type RespJson = {
      usage?: { input_tokens?: number; output_tokens?: number }
      output?: Array<{ type?: string; status?: string }>
    }
    let upstreamMs = 0
    const syncPromise: Promise<RespJson> = (async () => {
      const response = await callCopilotAPI({
        endpoint: "/v1/responses",
        payload: payload as unknown as Record<string, unknown>,
        operationName: "responses",
        copilotToken: state.copilotToken,
        accountType: state.accountType,
      })
      upstreamMs = upstreamTimer()
      return (await response.json()) as RespJson
    })()

    const recordSync = async (j: RespJson) => {
      if (!apiKeyId) return
      await trackNonStreamingUsage(j, apiKeyId, model, client)
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: false,
        inputTokens: j.usage?.input_tokens,
        outputTokens: j.usage?.output_tokens,
      }).catch(() => {})
    }

    const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
    if (raced.kind === "stream") return raced.response

    const j = raced.value
    await recordSync(j)
    const directJsonHeaders: Record<string, string> = { "Content-Type": "application/json" }
    if (directWebSearchEnabled) {
      const meta = countNativeWebSearchFromOutput(j.output)
      addWebSearchHeaders(directJsonHeaders, meta)
      recordWebSearchUsage(apiKeyId, meta)
    }
    return new Response(JSON.stringify(j), { headers: directJsonHeaders })
  }

  // ── Chat Completions fallback with format conversion ──

  const chatPayload = translateResponsesToChatCompletions(payload, model)

  if (payload.stream === true) {
    chatPayload.stream = true
    chatPayload.stream_options = { include_usage: true }

    const upstreamTimer = startTimer()
    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: chatPayload as unknown as Record<string, unknown>,
      operationName: "responses (via chat)",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    const upstreamMs = upstreamTimer()

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, { stream: true }).catch(() => {})
    }

    // Heartbeat BEFORE tee so both branches share the keepalive stream.
    // SSE comment ":" lines are ignored by createSSETransform's parser
    // (it filters on "data: " prefix), so usage extraction is unaffected.
    const heartbeated = wrapOpenAIHeartbeat(response.body)

    let usageBranch: ReadableStream<Uint8Array> | null = null
    let transformBranch: ReadableStream<Uint8Array> | null = null
    if (heartbeated) {
      const [a, b] = heartbeated.tee()
      usageBranch = a
      transformBranch = b
    }
    if (apiKeyId && usageBranch) {
      consumeStreamForUsage(usageBranch, apiKeyId, model, client)
    }
    const transformedBody = transformBranch?.pipeThrough(buildStreamTransform(payload, model))
    return new Response(transformedBody, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  // Non-streaming fallback
  chatPayload.stream = false

  const upstreamTimer = startTimer()
  let upstreamMs = 0
  const syncPromise: Promise<{ responsesResult: ReturnType<typeof translateChatCompletionsToResponses>; chatResponse: ChatCompletionResponse }> = (async () => {
    const response = await callCopilotAPI({
      endpoint: "/chat/completions",
      payload: chatPayload as unknown as Record<string, unknown>,
      operationName: "responses (via chat)",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
    })
    upstreamMs = upstreamTimer()
    const chatResponse = (await response.json()) as ChatCompletionResponse
    return { responsesResult: translateChatCompletionsToResponses(chatResponse, model, payload), chatResponse }
  })()

  const recordSync = async ({ responsesResult, chatResponse }: { responsesResult: ReturnType<typeof translateChatCompletionsToResponses>; chatResponse: ChatCompletionResponse }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(
      chatResponse,
      apiKeyId,
      model,
      client,
    )
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: responsesResult.usage.input_tokens,
      outputTokens: responsesResult.usage.output_tokens,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response

  const { responsesResult } = raced.value
  await recordSync(raced.value)
  return new Response(JSON.stringify(responsesResult), {
    headers: { "Content-Type": "application/json" },
  })
}

export const responsesRoute = new Elysia()
  .post("/v1/responses", handleResponses)
  .post("/responses", handleResponses)
