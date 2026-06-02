import { attachCacheControlMarkers } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

export const withCacheControlMarkersAttached: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-attach-cache-control-markers")) {
    attachCacheControlMarkers(
      inv.payload as { messages?: Array<{ role?: string; content?: unknown }> },
    )
  }
  return run()
}
