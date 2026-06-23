import { stripCacheControl } from "../../transforms/cache-control"
import type { CopilotInterceptor } from "@vnext/protocols/common"

/**
 * Strip unsupported `cache_control` sub-fields (`scope`, `ttl`) that strict
 * Copilot Messages slots reject. See `transforms/cache-control.ts` for the
 * full rationale and references.
 *
 * MUST run AFTER `withTopLevelCacheControlApplied` so the auto-applied marker
 * also gets its extensions cleaned.
 */
export const withCacheControlExtensionsStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  stripCacheControl(inv.payload as Record<string, unknown>)
  return run()
}
