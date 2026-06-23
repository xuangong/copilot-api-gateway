import { setMessagesVisionHeader } from "../../transforms"
import type { AnthropicMessagesPayload } from "../../transforms"
import type { CopilotInterceptor } from "@vnext/protocols/common"

export const withMessagesVisionHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-vision-header")) {
    setMessagesVisionHeader(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  }
  return run()
}
