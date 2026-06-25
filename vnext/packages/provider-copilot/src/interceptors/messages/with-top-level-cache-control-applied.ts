import { applyTopLevelCacheControl } from "../../transforms/apply-top-level-cache-control"
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

/**
 * Port the top-level Anthropic `cache_control` field onto the last cacheable
 * content block, mirroring the SDK's `MessageCreateParamsBase` semantics.
 *
 * Why: stricter Copilot Messages slots (haiku-4.5, sonnet-4.5/4.6, intermittently
 * opus-4.5) reject the top-level field with
 * `cache_control: Extra inputs are not permitted`. Reproducing the SDK's
 * auto-apply on the gateway side gives uniform behavior across slots.
 *
 * MUST run BEFORE `withCacheControlExtensionsStripped` — the ported value may
 * carry `scope`/`ttl` extensions which the strip pass cleans up.
 */
export const withTopLevelCacheControlApplied: CopilotInterceptor = async (inv, _ctx, run) => {
  applyTopLevelCacheControl(inv.payload as Record<string, unknown>)
  return run()
}
