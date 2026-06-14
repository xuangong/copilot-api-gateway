/**
 * Disable reasoning when the caller forces a specific tool — three protocol
 * variants (Messages / Chat Completions / Responses).
 *
 * Background: some upstreams reject requests that combine forced
 * `tool_choice` with enabled reasoning/thinking. The interceptor is opt-in
 * (gated by the `disable-reasoning-on-forced-tool-choice` flag) because the
 * tradeoff hurts non-affected upstreams.
 *
 * Vendor flags (`vendor-deepseek`, `vendor-qwen`) emit the upstream's
 * documented explicit-disable signal alongside the canonical OpenAI/Anthropic
 * removal. Without a vendor flag we only strip the reasoning field; we never
 * synthesize a `none` effort because upstreams disagree on whether that
 * value is legal.
 *
 * Borrowed-in-spirit from Menci/copilot-gateway.
 */

import type { AnthropicMessagesPayload, ResponsesPayload } from "./types"

interface ChatCompletionsLikePayload {
  tool_choice?:
    | string
    | { type: string; function?: { name?: string } }
    | null
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | null
  thinking?: { type: "disabled" } | unknown
  enable_thinking?: boolean
}

const messagesHasForcedToolChoice = (
  payload: AnthropicMessagesPayload,
): boolean => {
  const tc = (payload as unknown as { tool_choice?: { type?: string } })
    .tool_choice
  const type = tc?.type
  return type === "tool" || type === "any"
}

const responsesHasForcedToolChoice = (payload: ResponsesPayload): boolean => {
  const tc = payload.tool_choice
  if (tc === undefined || tc === null) return false
  if (typeof tc === "string") return tc === "required"
  return true
}

const chatHasForcedToolChoice = (
  payload: ChatCompletionsLikePayload,
): boolean => {
  const tc = payload.tool_choice
  if (tc === undefined || tc === null) return false
  if (typeof tc === "string") return tc === "required"
  return true
}

/**
 * Messages: strip `output_config.effort` (the thinking knob) and set
 * `thinking: { type: "disabled" }`, which is the protocol-native off switch.
 * Preserve `output_config.format` — structured outputs compose fine with
 * forced tool choice; only thinking did not.
 */
export function disableMessagesReasoningOnForcedToolChoice(
  payload: AnthropicMessagesPayload,
  enabledFlags: ReadonlySet<string>,
): boolean {
  if (!enabledFlags.has("disable-reasoning-on-forced-tool-choice")) return false
  if (!messagesHasForcedToolChoice(payload)) return false
  const mut = payload as unknown as {
    output_config?: { effort?: unknown; format?: unknown }
    thinking?: { type: "disabled" }
  }
  if (mut.output_config) {
    delete mut.output_config.effort
    if (Object.keys(mut.output_config).length === 0) {
      delete mut.output_config
    }
  }
  mut.thinking = { type: "disabled" }
  return true
}

/**
 * Responses: drop `reasoning`; add vendor-specific disable signals when the
 * matching vendor flag is also enabled.
 */
export function disableResponsesReasoningOnForcedToolChoice(
  payload: ResponsesPayload,
  enabledFlags: ReadonlySet<string>,
): boolean {
  if (!enabledFlags.has("disable-reasoning-on-forced-tool-choice")) return false
  if (!responsesHasForcedToolChoice(payload)) return false
  const mut = payload as unknown as {
    reasoning?: unknown
    thinking?: { type: "disabled" }
    enable_thinking?: false
  }
  delete mut.reasoning
  if (enabledFlags.has("vendor-deepseek")) mut.thinking = { type: "disabled" }
  if (enabledFlags.has("vendor-qwen")) mut.enable_thinking = false
  return true
}

/**
 * Chat Completions: drop `reasoning_effort`; add vendor-specific disable
 * signals when the matching vendor flag is also enabled.
 */
export function disableChatCompletionsReasoningOnForcedToolChoice(
  payload: ChatCompletionsLikePayload,
  enabledFlags: ReadonlySet<string>,
): boolean {
  if (!enabledFlags.has("disable-reasoning-on-forced-tool-choice")) return false
  if (!chatHasForcedToolChoice(payload)) return false
  delete payload.reasoning_effort
  if (enabledFlags.has("vendor-deepseek")) {
    payload.thinking = { type: "disabled" }
  }
  if (enabledFlags.has("vendor-qwen")) {
    payload.enable_thinking = false
  }
  return true
}
