import { stripStructuredOutputFormat } from "../../../../transforms/index"
import type { AnthropicMessagesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

export const withStructuredOutputFormatStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-strip-structured-output-format")) {
    stripStructuredOutputFormat(inv.payload as unknown as AnthropicMessagesPayload)
  }
  return run()
}
