import { Elysia } from "elysia"

import type { AppState, Env } from "~/lib/state"
import { callCopilotAPI, repairToolResultPairs } from "~/services/copilot"
import {
  interceptWebSearch,
  hasWebSearch,
  type WebSearchMeta,
  type MessagesPayload,
} from "~/services/web-search"
import {
  stripReservedKeywords,
  filterThinkingBlocks,
  adaptThinkingForModel,
  stripCacheControl,
  stripContextManagement,
  type AnthropicMessagesPayload,
} from "~/transforms"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { detectClient } from "~/lib/client-detect"
import { checkQuota } from "~/lib/quota"
import { getApiKeyById } from "~/lib/api-keys"
import { getRepo } from "~/repo"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { wrapAnthropicHeartbeat } from "~/lib/sse-heartbeat"

interface RouteContext {
  state: AppState
  env: Env
  body: AnthropicMessagesPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
}

function addWebSearchHeaders(
  headers: Record<string, string>,
  meta: WebSearchMeta,
): void {
  if (meta.searchCount > 0) {
    headers["X-Web-Search-Count"] = String(meta.searchCount)
    headers["X-Web-Search-Results"] = String(meta.totalResults)
    headers["X-Web-Search-Engines"] = meta.enginesUsed.join(",")
  }
}

// Timeout for non-streaming requests (5 minutes)
const SYNC_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export const messagesRoute = new Elysia()
  .post("/v1/messages", async (ctx) => {
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

    const payload: AnthropicMessagesPayload = {
      ...(body as AnthropicMessagesPayload),
    }

    // Apply compatibility transforms
    stripContextManagement(payload as unknown as Record<string, unknown>)
    stripReservedKeywords(payload)
    filterThinkingBlocks(payload)
    adaptThinkingForModel(payload)
    stripCacheControl(payload as unknown as Record<string, unknown>)

    // Repair tool result pairs
    if (Array.isArray(payload.messages)) {
      payload.messages = repairToolResultPairs(
        payload.messages,
      ) as typeof payload.messages
    }

    // Cast to MessagesPayload for web search interception
    const messagesPayload = payload as unknown as MessagesPayload

    if (hasWebSearch(messagesPayload) && !payload.stream) {
      // Load key-level web search config
      const keyConfig = apiKeyId ? await getApiKeyById(apiKeyId) : null
      if (!keyConfig?.webSearchEnabled) {
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Web search is not enabled for this API key. Configure it in the dashboard." } }), {
          status: 400, headers: { "Content-Type": "application/json" },
        })
      }

      const upstreamTimer = startTimer()
      const upstreamPromise = interceptWebSearch(messagesPayload, {
        copilotToken: state.copilotToken,
        accountType: state.accountType,
        engineOptions: {
          langsearchKey: keyConfig.webSearchLangsearchKey,
          tavilyKey: keyConfig.webSearchTavilyKey,
          bingEnabled: keyConfig.webSearchBingEnabled,
        },
      })

      const recordSideEffects = async (
        result: { response: unknown; meta: WebSearchMeta },
      ) => {
        const { response, meta } = result
        const upstreamMs = upstreamTimer()
        if (apiKeyId) {
          await trackNonStreamingUsage(response, apiKeyId, payload.model, client)
          const usage = response as { usage?: { input_tokens?: number; output_tokens?: number } }
          recordLatency(apiKeyId, payload.model, colo, {
            totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
          }, requestId, {
            stream: false,
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
          }
        }
      }

      const raced = await raceWithHeartbeat(upstreamPromise, {
        serialize: (v) => JSON.stringify(v.response),
        onResolve: recordSideEffects,
      })

      if (raced.kind === "stream") {
        // Headers (incl. X-Web-Search-*) are locked once streaming starts;
        // we omit them on the slow path. Caller can still inspect response body.
        return raced.response
      }

      const { response, meta } = raced.value
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      addWebSearchHeaders(headers, meta)
      const wsResponse = new Response(JSON.stringify(response), { headers })
      await recordSideEffects(raced.value)
      return wsResponse
    }

    const upstreamTimer = startTimer()
    const isStreaming = payload.stream === true

    if (isStreaming) {
      const response = await callCopilotAPI({
        endpoint: "/v1/messages",
        payload: payload as unknown as Record<string, unknown>,
        operationName: "create message",
        copilotToken: state.copilotToken,
        accountType: state.accountType,
      })
      const upstreamMs = upstreamTimer()
      // Wrap upstream body in an idle-heartbeat stream so Cloudflare edge
      // does not close the client connection while the model is thinking.
      // Anthropic's official "event: ping" frame is the protocol-noop here —
      // SDKs already filter it out as a keepalive.
      const heartbeated = wrapAnthropicHeartbeat(response.body)
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
      return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, payload.model, client) : streamResponse
    }

    // Non-streaming: wrap the full upstream chain in a heartbeat race so the
    // client connection survives Cloudflare edge's ~60s idle timeout.
    type SyncJson = { usage?: { input_tokens?: number; output_tokens?: number } }
    let upstreamMs = 0
    const syncPromise: Promise<SyncJson> = (async () => {
      const response = await callCopilotAPI({
        endpoint: "/v1/messages",
        payload: payload as unknown as Record<string, unknown>,
        operationName: "create message",
        copilotToken: state.copilotToken,
        accountType: state.accountType,
        timeout: SYNC_REQUEST_TIMEOUT_MS,
      })
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
  })
  .post("/v1/messages/count_tokens", async (ctx) => {
    const { state, body } = ctx as unknown as RouteContext

    const payload: AnthropicMessagesPayload = {
      ...(body as AnthropicMessagesPayload),
    }

    // Apply compatibility transforms
    stripContextManagement(payload as unknown as Record<string, unknown>)
    stripCacheControl(payload as unknown as Record<string, unknown>)

    // Repair tool result pairs
    if (Array.isArray(payload.messages)) {
      payload.messages = repairToolResultPairs(
        payload.messages,
      ) as typeof payload.messages
    }

    const response = await callCopilotAPI({
      endpoint: "/v1/messages/count_tokens",
      payload: payload as unknown as Record<string, unknown>,
      operationName: "count tokens",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
      requireModel: false,
    })

    return response.json()
  })
