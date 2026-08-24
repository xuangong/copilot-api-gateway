import { filterThinkingBlocks } from "../../transforms/thinking-cleanup"
import type { AnthropicMessagesPayload } from "../../transforms/types"
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

/**
 * Drop empty / "Thinking..." placeholder thinking blocks from assistant turns
 * (some clients echo these back; upstream rejects them).
 *
 * The thinking *contract* adaptation (enabled ↔ adaptive, output_config
 * stripping) used to live here too, keyed off a regex over the model id. It
 * now reads `capabilities.supports` and therefore runs inside
 * `withVariantAndBetaFiltering`, which is the interceptor holding the
 * raw_models catalog — and which must see the adapted payload to decide the
 * anthropic-beta header. Only the block filtering, which needs no catalog,
 * stayed behind.
 *
 * Ported from `src/transforms/pipeline.ts:49-50` in the legacy gateway.
 */
export const withThinkingAdapted: CopilotInterceptor = async (inv, _ctx, run) => {
  const payload = inv.payload as unknown as AnthropicMessagesPayload
  filterThinkingBlocks(payload)
  return run()
}
