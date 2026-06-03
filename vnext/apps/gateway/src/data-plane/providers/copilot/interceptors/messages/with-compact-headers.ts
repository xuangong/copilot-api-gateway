import { setCompactHeaders } from "../../../../transforms/index"
import type { AnthropicMessagesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

export const withCompactHeaders: CopilotInterceptor = async (inv, _ctx, run) => {
  setCompactHeaders(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  return run()
}
