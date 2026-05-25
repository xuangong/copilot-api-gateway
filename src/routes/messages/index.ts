import { Elysia } from "elysia"

import { startTimer } from "~/lib/latency-tracker"
import { checkQuota } from "~/lib/quota"
import { createCopilotProvider } from "~/providers/registry"
import type { MessagesPayload } from "~/services/web-search"
import {
  runAnthropicCountTokensPipeline,
  runAnthropicMessagesPipeline,
  type AnthropicMessagesPayload,
} from "~/transforms"

import { handleMessagesViaChatCompletions } from "./chat-completions-fallback"
import { handleDirectMessages } from "./direct"
import { handleMessagesViaResponses } from "./responses-fallback"
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
    const flags = runAnthropicMessagesPipeline(payload)

    const messagesPayload = payload as unknown as MessagesPayload
    if (hasWebSearch(messagesPayload)) {
      return handleWebSearch(routeCtx, payload, messagesPayload, elapsed)
    }

    // gpt-5.x only serves /v1/responses upstream — translate Messages↔Responses.
    if (payload.model.startsWith("gpt-5")) {
      return handleMessagesViaResponses(routeCtx, payload, elapsed)
    }

    // Other gpt-* models only serve /v1/chat/completions — translate
    // Messages↔Chat Completions on both legs.
    if (payload.model.startsWith("gpt-")) {
      return handleMessagesViaChatCompletions(routeCtx, payload, elapsed)
    }

    return handleDirectMessages(
      routeCtx,
      payload,
      passthroughHeaders,
      flags.thinkingPromotion.promoted,
      elapsed,
    )
  })
  .post("/v1/messages/count_tokens", async (ctx) => {
    const { state, body } = ctx as unknown as RouteContext
    const payload: AnthropicMessagesPayload = { ...(body as AnthropicMessagesPayload) }

    runAnthropicCountTokensPipeline(payload)

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
