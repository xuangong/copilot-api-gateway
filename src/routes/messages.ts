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
  stripCacheControl,
  type AnthropicMessagesPayload,
} from "~/transforms"
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { detectClient } from "~/lib/client-detect"

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

    const payload: AnthropicMessagesPayload = {
      ...(body as AnthropicMessagesPayload),
    }

    // Apply compatibility transforms
    stripReservedKeywords(payload)
    filterThinkingBlocks(payload)
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
      const upstreamTimer = startTimer()
      const { response, meta } = await interceptWebSearch(messagesPayload, {
        copilotToken: state.copilotToken,
        accountType: state.accountType,
        engineOptions: {
          langsearchKey: state.langsearchKey,
          tavilyKey: state.tavilyKey,
        },
      })
      const upstreamMs = upstreamTimer()

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      addWebSearchHeaders(headers, meta)

      const wsResponse = new Response(JSON.stringify(response), { headers })
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
      }
      return wsResponse
    }

    const upstreamTimer = startTimer()
    // Use timeout only for non-streaming requests
    const isStreaming = payload.stream === true
    const response = await callCopilotAPI({
      endpoint: "/v1/messages",
      payload: payload as unknown as Record<string, unknown>,
      operationName: "create message",
      copilotToken: state.copilotToken,
      accountType: state.accountType,
      timeout: isStreaming ? undefined : SYNC_REQUEST_TIMEOUT_MS,
    })
    const upstreamMs = upstreamTimer()

    if (isStreaming) {
      const streamResponse = new Response(response.body, {
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

    const json = await response.json() as { usage?: { input_tokens?: number; output_tokens?: number } }
    const jsonResponse = new Response(JSON.stringify(json), {
      headers: { "Content-Type": "application/json" },
    })
    if (apiKeyId) {
      await trackNonStreamingUsage(json, apiKeyId, payload.model, client)
      recordLatency(apiKeyId, payload.model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, {
        stream: false,
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
        userAgent,
      }).catch((e) => console.error('[latency] record error:', e))
    }
    return jsonResponse
  })
  .post("/v1/messages/count_tokens", async (ctx) => {
    const { state, body } = ctx as unknown as RouteContext

    const payload: AnthropicMessagesPayload = {
      ...(body as AnthropicMessagesPayload),
    }

    // Apply compatibility transforms
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
