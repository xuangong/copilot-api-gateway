/**
 * Request-side transform pipelines.
 *
 * A pipeline is a fixed-order list of mutations applied to a payload before
 * it goes upstream. Each pipeline returns a `flags` object describing which
 * mitigations were applied — the route uses these flags to wire matching
 * response-side handlers (e.g. SSE thinking-delta stripping).
 *
 * Why pipeline a route's prelude:
 *   - One canonical order for the mutations. Order matters
 *     (e.g. stripContextManagement before stripCacheControl).
 *   - Routes stay declarative — they describe WHICH protocol they speak,
 *     not the mechanics of each individual mitigation.
 *   - Flag aggregation gives downstream handlers a single object to read.
 */

import { repairToolResultPairs } from "~/services/copilot"

import { applyTopLevelCacheControl } from "./apply-top-level-cache-control"
import { stripReservedKeywords } from "./billing-header"
import { stripCacheControl } from "./cache-control"
import { stripContextManagement } from "./context-management"
import { disableMessagesReasoningOnForcedToolChoice } from "./disable-reasoning-on-forced-tool-choice"
import {
  promoteThinkingDisplayForStreaming,
  type PromoteThinkingDisplayResult,
} from "./promote-thinking-display"
import { adaptThinkingForModel, filterThinkingBlocks } from "./thinking-cleanup"
import { stripToolStrict } from "./strip-tool-strict"
import { fixApplyPatchTools } from "./tool-type"
import type { AnthropicMessagesPayload, ResponsesPayload } from "./types"

export interface AnthropicMessagesPipelineFlags {
  thinkingPromotion: PromoteThinkingDisplayResult
}

/**
 * Anthropic /v1/messages request prelude. Mutates `payload` in place and
 * returns flags downstream handlers need to honor (e.g. did we promote
 * thinking.display? then the response stream must strip thinking_deltas).
 */
export function runAnthropicMessagesPipeline(
  payload: AnthropicMessagesPayload,
  enabledFlags: ReadonlySet<string> = new Set(),
): AnthropicMessagesPipelineFlags {
  stripContextManagement(payload as unknown as Record<string, unknown>)
  stripReservedKeywords(payload)
  disableMessagesReasoningOnForcedToolChoice(payload, enabledFlags)
  filterThinkingBlocks(payload)
  adaptThinkingForModel(payload)
  // Run BEFORE stripCacheControl so any extensions (scope/ttl) that ride along
  // with the top-level field get cleaned up by the stripper.
  applyTopLevelCacheControl(payload as unknown as Record<string, unknown>)
  stripCacheControl(payload as unknown as Record<string, unknown>)
  // Vertex-backed Copilot rejects tools.N.strict:true with FAILED_PRECONDITION.
  if (enabledFlags.has("transform-strip-tool-strict")) {
    stripToolStrict(payload)
  }
  // Copilot rejects tools.N.custom.eager_input_streaming with
  // "Extra inputs are not permitted". Strip before forwarding.
  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map((tool) => {
      const { eager_input_streaming: _, ...rest } = tool as typeof tool & { eager_input_streaming?: unknown }
      return rest
    })
  }
  const thinkingPromotion = promoteThinkingDisplayForStreaming(payload)
  if (Array.isArray(payload.messages)) {
    payload.messages = repairToolResultPairs(payload.messages) as typeof payload.messages
  }
  return { thinkingPromotion }
}

/**
 * Minimal pipeline for /v1/messages/count_tokens — no thinking handling,
 * no tool-result repair semantics beyond context cleanup.
 */
export function runAnthropicCountTokensPipeline(payload: AnthropicMessagesPayload): void {
  stripContextManagement(payload as unknown as Record<string, unknown>)
  applyTopLevelCacheControl(payload as unknown as Record<string, unknown>)
  stripCacheControl(payload as unknown as Record<string, unknown>)
  if (Array.isArray(payload.messages)) {
    payload.messages = repairToolResultPairs(payload.messages) as typeof payload.messages
  }
}

export interface ResponsesChatFallbackPipelineFlags {
  /** Always true after this pipeline — marker for diagnostics. */
  rewrittenForChatFallback: true
}

/**
 * Responses → chat-completions fallback prelude. Compaction lives in
 * the chat-fallback handler itself (it needs the byte budget local to that
 * call). This pipeline only handles the apply_patch tool rewrite that any
 * chat-fallback path requires.
 */
export function runResponsesChatFallbackPipeline(
  payload: ResponsesPayload,
): ResponsesChatFallbackPipelineFlags {
  fixApplyPatchTools(payload)
  return { rewrittenForChatFallback: true }
}
