import { attachMessagesCacheBreakpoints } from "../../transforms"
import type { AnthropicMessagesPayload } from "../../transforms"
import type { CopilotInterceptor } from "@vnext/protocols/common"

export const withMessagesCacheBreakpointsAttached: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-attach-messages-cache-breakpoints")) {
    attachMessagesCacheBreakpoints(inv.payload as unknown as AnthropicMessagesPayload)
  }
  return run()
}
