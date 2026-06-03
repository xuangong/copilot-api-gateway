import { attachMessagesCacheBreakpoints } from "../../../../transforms/index"
import type { AnthropicMessagesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

export const withMessagesCacheBreakpointsAttached: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-attach-messages-cache-breakpoints")) {
    attachMessagesCacheBreakpoints(inv.payload as unknown as AnthropicMessagesPayload)
  }
  return run()
}
