import { setMessagesVisionHeader } from "../../../../transforms/index"
import type { AnthropicMessagesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

export const withMessagesVisionHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-vision-header")) {
    setMessagesVisionHeader(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  }
  return run()
}
