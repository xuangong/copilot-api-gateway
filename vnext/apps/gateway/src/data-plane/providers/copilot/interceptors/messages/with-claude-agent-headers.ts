import { setClaudeAgentHeaders } from "../../../../transforms/index"
import type { AnthropicMessagesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

export const withClaudeAgentHeaders: CopilotInterceptor = async (inv, _ctx, run) => {
  setClaudeAgentHeaders(inv.payload as unknown as AnthropicMessagesPayload, inv.headers)
  return run()
}
