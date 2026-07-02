import { adaptThinkingForModel, filterThinkingBlocks } from "../../transforms/thinking-cleanup"
import type { AnthropicMessagesPayload } from "../../transforms/types"
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

/**
 * Normalize thinking/output_config fields per upstream model contract.
 *
 * Why: Claude-4.5 Haiku rejects `output_config` outright with
 * `invalid_reasoning_effort`, and Claude 4.7+ models reject the legacy
 * `thinking.type: "enabled"` shape with "use thinking.type.adaptive and
 * output_config.effort". This interceptor reshapes the payload before
 * forwarding so clients can keep their existing request shape.
 *
 * Order: MUST run AFTER `variantFiltering`. variantFiltering injects an
 * `output_config.effort` value derived from composite model ids / headers,
 * so reasoning-stripping has to come after the injection to remove what was
 * just injected. Provider chain order: variantFiltering → … → messagesPayload
 * interceptors. Place this near the head of `messagesPayloadInterceptors`.
 *
 * Also drops empty / "Thinking..." placeholder thinking blocks from the
 * assistant turns (some clients echo these back; upstream rejects them).
 *
 * Ported from `src/transforms/pipeline.ts:49-50` in the legacy gateway.
 */
export const withThinkingAdapted: CopilotInterceptor = async (inv, _ctx, run) => {
  const payload = inv.payload as unknown as AnthropicMessagesPayload
  filterThinkingBlocks(payload)
  adaptThinkingForModel(payload)
  return run()
}
