import { Elysia } from "elysia"

import { stripUpstreamPin } from "~/lib/binding-resolver"
import { startTimer } from "~/lib/latency-tracker"
import { checkQuota } from "~/lib/quota"
import {
  hasResponsesWebSearch,
  loadWebSearchConfig,
} from "~/services/web-search"
import { disableResponsesReasoningOnForcedToolChoice, stripServiceTier, stripWebSearchTools, type ResponsesPayload } from "~/transforms"

import { handleChatFallback } from "./chat-fallback"
import { handleDirectNonStreaming, handleDirectStreaming } from "./direct"
import { handleResponsesViaMessages } from "./messages-fallback"
import {
  rewriteCodexAutoReviewAlias,
  shouldUseChatFallback,
  statefulContinuationNotFoundResponse,
  type RouteContext,
} from "./utils"
import { handleWebSearchIntercepted } from "./web-search"

const handleResponses = async (ctx: unknown) => {
  const routeCtx = ctx as unknown as RouteContext
  const { state, body, apiKeyId } = routeCtx
  const elapsed = startTimer()

  if (apiKeyId) {
    const quota = await checkQuota(apiKeyId)
    if (!quota.allowed) {
      return new Response(
        JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )
    }
  }

  const payload: ResponsesPayload = rewriteCodexAutoReviewAlias({
    ...(body as ResponsesPayload),
  })
  stripServiceTier(payload as unknown as Record<string, unknown>)
  // Strip optional `up_X/model` pin (G1). Pin is parked on
  // payload.__upstreamPin and consumed by downstream resolveBinding.
  stripUpstreamPin(payload as unknown as Record<string, unknown>)
  // Pre-dispatch transform — runs before binding resolution because the
  // result feeds into the claude/gpt-5 routing decision below. Per-upstream
  // flag overrides therefore can't influence this step; only state-level
  // (account-default) flags apply. The post-dispatch fallback / direct
  // handlers re-resolve effective flags via the binding for their own
  // pipelines.
  disableResponsesReasoningOnForcedToolChoice(payload, state.enabledFlags ?? new Set())

  // Stateless gateway: refuse server-side history references with the same
  // 400/404 codex/cline/openai-agents-python use to trigger their full-input
  // retry path, instead of silently sending broken refs upstream.
  const notFound = statefulContinuationNotFoundResponse(payload)
  if (notFound) return notFound

  // claude-* 模型走 Messages 上游,需要 Responses ↔ Messages 双向翻译
  if (payload.model.startsWith("claude-")) {
    return handleResponsesViaMessages(routeCtx, payload, elapsed)
  }

  const useChatFallback = shouldUseChatFallback(payload.model)
  const wantsWebSearch = hasResponsesWebSearch(payload)

  // Chat-fallback web_search runs a custom intercept loop.
  if (wantsWebSearch && useChatFallback) {
    return handleWebSearchIntercepted(routeCtx, payload, elapsed)
  }

  // Chat-fallback without web_search: strip any leftover web_search tool so
  // upstream sees a clean list. (Direct gpt-5.x path keeps web_search since
  // Copilot executes it natively.)
  if (payload.tools && useChatFallback) {
    payload.tools = stripWebSearchTools(payload.tools)
  }

  // Direct path with web_search: enforce key-level permission (parity with
  // chat-fallback intercept).
  let directWebSearchEnabled = false
  if (wantsWebSearch && !useChatFallback) {
    const cfg = await loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)
    if (!cfg.enabled) return cfg.errorResponse!
    directWebSearchEnabled = true
  }

  if (!useChatFallback) {
    return payload.stream === true
      ? handleDirectStreaming(routeCtx, payload, directWebSearchEnabled, elapsed)
      : handleDirectNonStreaming(routeCtx, payload, directWebSearchEnabled, elapsed)
  }

  return handleChatFallback(routeCtx, payload, elapsed)
}

export const responsesRoute = new Elysia()
  .post("/v1/responses", handleResponses)
  .post("/responses", handleResponses)
