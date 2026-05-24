import { Elysia } from "elysia"

import { startTimer } from "~/lib/latency-tracker"
import { checkQuota } from "~/lib/quota"
import { createCopilotProvider } from "~/providers/registry"
import { repairToolResultPairs } from "~/services/copilot"
import type { MessagesPayload } from "~/services/web-search"
import {
  adaptThinkingForModel,
  filterThinkingBlocks,
  promoteThinkingDisplayForStreaming,
  stripCacheControl,
  stripContextManagement,
  stripReservedKeywords,
  type AnthropicMessagesPayload,
} from "~/transforms"

import { handleDirectMessages } from "./direct"
import {
  extractAnthropicPassthroughHeaders,
  logOfficeClientEntry,
  type RouteContext,
} from "./utils"
import { handleWebSearch, hasWebSearch } from "./web-search"

export const messagesRoute = new Elysia()
  .post("/v1/messages", async (ctx) => {
    const routeCtx = ctx as unknown as RouteContext
    const { body, apiKeyId, requestId, userAgent } = routeCtx
    const elapsed = startTimer()

    const passthroughHeaders = extractAnthropicPassthroughHeaders(ctx)
    logOfficeClientEntry(ctx, body as AnthropicMessagesPayload, requestId, userAgent, elapsed)

    if (apiKeyId) {
      const quota = await checkQuota(apiKeyId)
      if (!quota.allowed) {
        return new Response(
          JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        )
      }
    }

    const payload: AnthropicMessagesPayload = { ...(body as AnthropicMessagesPayload) }

    stripContextManagement(payload as unknown as Record<string, unknown>)
    stripReservedKeywords(payload)
    filterThinkingBlocks(payload)
    adaptThinkingForModel(payload)
    stripCacheControl(payload as unknown as Record<string, unknown>)

    // Promote thinking.display omitted → summarized for streaming on
    // Claude 4.5/4.6 so the upstream stream gets continuous thinking_delta
    // events. We strip those deltas back out in the direct handler to honor
    // the client's original "omitted" intent.
    const thinkingPromotion = promoteThinkingDisplayForStreaming(payload)

    if (Array.isArray(payload.messages)) {
      payload.messages = repairToolResultPairs(payload.messages) as typeof payload.messages
    }

    const messagesPayload = payload as unknown as MessagesPayload
    if (hasWebSearch(messagesPayload)) {
      return handleWebSearch(routeCtx, payload, messagesPayload, elapsed)
    }

    return handleDirectMessages(
      routeCtx,
      payload,
      passthroughHeaders,
      thinkingPromotion.promoted,
      elapsed,
    )
  })
  .post("/v1/messages/count_tokens", async (ctx) => {
    const { state, body } = ctx as unknown as RouteContext
    const payload: AnthropicMessagesPayload = { ...(body as AnthropicMessagesPayload) }

    stripContextManagement(payload as unknown as Record<string, unknown>)
    stripCacheControl(payload as unknown as Record<string, unknown>)

    if (Array.isArray(payload.messages)) {
      payload.messages = repairToolResultPairs(payload.messages) as typeof payload.messages
    }

    const provider = createCopilotProvider({ copilotToken: state.copilotToken, accountType: state.accountType })
    const response = await provider.callMessagesCountTokens(
      payload as unknown as Record<string, unknown>,
      {
        operationName: "count tokens",
        extraHeaders: extractAnthropicPassthroughHeaders(ctx),
      },
    )

    return response.json()
  })
