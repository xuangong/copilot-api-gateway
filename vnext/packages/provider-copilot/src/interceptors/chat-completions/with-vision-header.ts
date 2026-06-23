import { setChatCompletionsVisionHeader } from "../../transforms"
import type { CopilotInterceptor } from "@vnext/protocols/common"

export const withChatCompletionsVisionHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-vision-header")) {
    setChatCompletionsVisionHeader(
      inv.payload as { messages?: Array<{ content?: unknown }> },
      inv.headers,
    )
  }
  return run()
}
