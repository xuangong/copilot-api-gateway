import { Elysia } from "elysia"

import { resolveBinding, stripUpstreamPin, pinFromPayload } from "~/lib/binding-resolver"
import { HTTPError } from "~/lib/error"
import { startTimer } from "~/lib/latency-tracker"
import { checkQuota } from "~/lib/quota"
import type { MessagesPayload } from "~/services/web-search"
import {
  anthropicContextWindowErrorBody,
  isContextWindowError,
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
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (quota.retryAfterSeconds) headers["Retry-After"] = String(quota.retryAfterSeconds)
        return new Response(
          JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }),
          { status: 429, headers },
        )
      }
    }

    const payload: AnthropicMessagesPayload = { ...(body as AnthropicMessagesPayload) }
    // Strip optional `up_X/model` pin before any branching — the pin is
    // parked on payload.__upstreamPin and read by downstream resolveBinding.
    stripUpstreamPin(payload as unknown as Record<string, unknown>)
    const flags = runAnthropicMessagesPipeline(payload, routeCtx.state.enabledFlags ?? new Set())

    try {
      // gpt-5.x only serves /v1/responses upstream — translate Messages↔Responses.
      if (payload.model.startsWith("gpt-5")) {
        return await handleMessagesViaResponses(routeCtx, payload, elapsed)
      }

      // Other gpt-* models only serve /v1/chat/completions — translate
      // Messages↔Chat Completions on both legs.
      if (payload.model.startsWith("gpt-")) {
        return await handleMessagesViaChatCompletions(routeCtx, payload, elapsed)
      }

      // Anthropic web_search intercept — only for native Anthropic models (claude-*
      // and any non-GPT model). GPT models use their own web search path above.
      const messagesPayload = payload as unknown as MessagesPayload
      if (hasWebSearch(messagesPayload)) {
        return await handleWebSearch(routeCtx, payload, messagesPayload, elapsed)
      }

      return await handleDirectMessages(
        routeCtx,
        payload,
        passthroughHeaders,
        flags.thinkingPromotion.promoted,
        elapsed,
      )
    } catch (err) {
      // Normalize upstream context-window errors into Anthropic's
      // `invalid_request_error` shape so Claude Code (and any other client
      // that gates auto-compact on this exact message) actually compacts
      // instead of surfacing the raw Copilot/Vertex error.
      if (err instanceof HTTPError) {
        const text = await err.response.clone().text().catch(() => "")
        if (isContextWindowError(text)) {
          return new Response(anthropicContextWindowErrorBody(), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        }
      }
      throw err
    }
  })
  .post("/v1/messages/count_tokens", async (ctx) => {
    const { state, body, userId } = ctx as unknown as RouteContext
    const payload: AnthropicMessagesPayload = { ...(body as AnthropicMessagesPayload) }

    runAnthropicCountTokensPipeline(payload)

    stripUpstreamPin(payload as unknown as Record<string, unknown>)
    const binding = await resolveBinding(state, userId, payload.model, "messages_count_tokens", pinFromPayload(payload as unknown as Record<string, unknown>))
    if (!binding) {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `No messages_count_tokens upstream available for model: ${payload.model}. Run GET /v1/models for available ids.` } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }
    const response = await binding.provider.fetch(
      "messages_count_tokens",
      { method: "POST", body: JSON.stringify(payload) },
      {
        operationName: "count tokens",
        extraHeaders: extractAnthropicPassthroughHeaders(ctx),
        enabledFlags: binding.enabledFlags,
      },
    )

    return response.json()
  })
