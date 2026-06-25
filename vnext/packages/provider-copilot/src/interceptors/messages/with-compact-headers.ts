import { setCompactHeaders } from "../../transforms"
import type { AnthropicMessagesPayload } from "../../transforms"
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

export const withCompactHeaders: CopilotInterceptor = async (inv, _ctx, run) => {
  setCompactHeaders(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  return run()
}
