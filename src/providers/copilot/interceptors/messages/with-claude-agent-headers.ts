import { setClaudeAgentHeaders } from "~/transforms"
import type { AnthropicMessagesPayload } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

export const withClaudeAgentHeaders: CopilotInterceptor = async (inv, _ctx, run) => {
  setClaudeAgentHeaders(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  return run()
}
