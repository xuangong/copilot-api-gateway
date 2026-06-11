import { setInteractionIdHeader } from "../../transforms"
import type { AnthropicMessagesPayload } from "../../transforms"
import type { CopilotInterceptor } from "@vnext/interceptor"

export const withInteractionIdHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-set-interaction-id-header")) {
    await setInteractionIdHeader(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  }
  return run()
}
